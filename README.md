# Plan3D — du plan d'architecte à la visite 3D

Application web (Next.js 16, React Three Fiber) qui transforme un plan en maison 3D visitable, puis aménagée.

```bash
npm install
npm run dev -- -p 3001   # http://localhost:3001
```

## Parcours

1. **Plan**
   - Import d'un **DXF** (AutoCAD, ArchiCAD, Revit…) : murs en double trait, portes (arcs ou blocs), fenêtres, noms des pièces lus dans les textes. Pièces détectées automatiquement, surfaces exactes.
   - Import d'un **PDF** (page au choix s'il en a plusieurs) ou d'une **image** : **lecture automatique**, sans IA (`src/lib/raster.ts`). Les murs coupés (pleins ou hachurés) sont repérés comme des bandes d'épaisseur régulière bordées de deux contours continus, puis suivis à travers les fenêtres (traits fins parallèles) ; portes reconnues à leur arc. Les noms et surfaces écrits sur le plan sont lus par OCR (Tesseract, `src/lib/ocr.ts`, données de langue chargées depuis le CDN jsDelivr) : les pièces sont nommées et l'échelle est déduite des surfaces (« 22,12 m² »). Sinon, échelle estimée d'après l'épaisseur des murs, à vérifier avec l'outil Échelle.
   - Le plan reste affiché en calque : on complète ou corrige à la main (murs, ouvertures, types de pièces), ou on relance « Relire le plan automatiquement ».
   - Outils : mur, porte, fenêtre, baie vitrée, passage, pièce (clic dans une zone fermée), détection de toutes les pièces, escalier (ajout, sens de la montée), annuler / rétablir, enregistrement `.plan3d.json`.
   - **Étages** (panneau Niveaux) : un plan par niveau. « + Étage » reprend les façades du dessous ; on importe le plan de l'étage (page 2 du PDF…) et il est **calé automatiquement** sur le rez-de-chaussée (bouton « Caler » et flèches de 10 cm pour ajuster). Le niveau du dessous et la trémie de son escalier s'affichent en gris.
2. **Maison 3D** : maquette (vue en coupe à 1,10 m ou murs entiers, niveau par niveau, noms et surfaces des pièces), **animation « la maison se construit »** depuis le plan (jouée en arrivant du plan, rejouable, et filmable en vidéo), visite libre à hauteur d'yeux (Z Q S D, collisions, on monte l'escalier), **visite guidée** automatique depuis l'entrée, pièce par pièce, puis l'escalier et l'étage, casque VR (WebXR), export **GLB**.
3. **Intérieur — design d'espace** : 4 styles (contemporain, afro-chic, minimaliste béton, tropical), ameublement automatique selon le type de pièce, puis aménagement à la main : catalogue de meubles, sélection et déplacement à la souris dans la 3D, rotation (R), dimensions, duplication, suppression ; sol et peinture choisis pièce par pièce. Option « dessin du plan au sol » : le plan importé est plaqué au sol en 3D, à l'échelle (meubles dessinés, jardin, voiture…).

Plans d'essai : `public/exemples/maison-b.{pdf,png,dxf}`, la villa d'exemple et le duplex d'exemple (R+1 : escalier, mezzanine, terrasse) intégrés.

## Code

- `src/lib/` : modèle (`types`, `store`), étages (`levels` : le niveau actif vit dans `walls`/`rooms`… du projet, les autres dans `levels[i].data`), géométrie, import DXF (`dxf`), détection des pièces (`roomDetect`), ameublement (`furnish`), visite guidée (`tour`, `tourPlayer`), styles, textures procédurales.
- `src/components/editor/Editor2D.tsx` : éditeur SVG.
- `src/components/three/` : maison 3D, mobilier, visionneuse (maquette / visite / guidée / VR / export).

Tout tourne dans le navigateur : aucun serveur, aucune clé d'API (seul l'OCR télécharge ses fichiers de langue depuis jsDelivr au premier usage). Le projet est sauvegardé dans le stockage local du navigateur.

## Rendu IA réaliste (open source, GPU RunPod)

Bouton **Rendu IA** dans la 3D. La géométrie vient toujours de la 3D, donc du plan : l'IA ne fait que l'habiller.

- **Photo réaliste** de la vue (Qwen-Image-Edit 2511 + Lightning, ~20 s). Avec « Géométrie verrouillée », la carte de
  profondeur exacte de la même vue accompagne la capture (image 2) : murs, portes et fenêtres restent ceux du plan.
- **Vidéo fidèle de la visite** (en visite libre ou guidée) : on choisit une pièce, l'app rend le plan de la visite guidée
  image par image (81 images à 16 im/s : entrée dans la pièce puis tour du regard), en profondeur, sans perte (APNG en niveaux
  de gris, `src/lib/png.ts`). Sur le pod : photo réaliste de la première image (Qwen, guidé par sa profondeur), puis
  Wan 2.2 Fun Control 14B qui suit la profondeur de chaque image en gardant l'aspect de cette photo.
- **Photo animée** (boutons sous une photo) : la 3D refait la vue exacte de la photo et bouge un peu (travelling avant dans une
  pièce, rotation lente autour de la maison) ; Wan 2.2 Fun Control suit cette profondeur avec la photo pour modèle.
- **Qualité max** (visite ou photo animée) : 720p accéléré, puis affinage en 1080p par SeedVR2 (téléchargé seul au premier
  usage) et 32 images/s par RIFE (~6 min sur L40S). 20 étapes complètes sans accélération coûtaient 23 min pour moins de gain.

La profondeur est rendue par la 3D elle-même (`src/components/three/capture.ts`) : proche = blanc, loin et ciel = noir,
échelle logarithmique calée sur ce que voit chaque image et lissée sur ±1 s (pas de scintillement). Le déroulé de la visite
(`src/lib/tourPlayer.ts`) est le même à l'écran et à l'export.

Les calculs tournent dans ComfyUI sur un pod RunPod (48 Go : L40, L40S ou A6000), joint par un tunnel SSH ; l'app passe par
`/api/rendu` (le navigateur ne parle jamais au pod). Les modèles sont choisis parmi ceux présents sur le pod (2511 de préférence,
2509 sinon) ; `QWEN_ANYTHING2REAL=0` dans `.env.local` retire la LoRA Anything2Real pour comparer.

- `.env.local` : `COMFYUI_URL=http://127.0.0.1:18188`
- installation des modèles sur le pod : `scripts/runpod/install_models.py` (photo + visite fidèle ≈ 75 Go ; groupes `image`, `controle`, `video`, `tout`)
- reprise d'une séance après Stop/Start du pod : `scripts/runpod/session.sh <ip> <port>`
- essais en ligne de commande : `scripts/runpod/comfy_run.py photo|video <url> <image>`

## Pistes avec l'IA (clé d'API nécessaire)

- Plans photographiés de travers, dessinés à la main ou très chargés : la lecture sans IA atteint ses limites (murs manquants, pièces fusionnées).
- Propositions d'aménagement et de décoration à partir d'une consigne.
- Rendus photoréalistes des pièces.
