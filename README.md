# Plan3D — du plan d'architecte à la visite 3D

Application web (Next.js 16, React Three Fiber) qui transforme un plan en maison 3D visitable, puis aménagée.

```bash
npm install
npm run dev -- -p 3001   # http://localhost:3001
```

## Parcours

1. **Plan**
   - Import d'un **DXF** (AutoCAD, ArchiCAD, Revit…) : murs en double trait, portes (arcs ou blocs), fenêtres, noms des pièces lus dans les textes. Pièces détectées automatiquement, surfaces exactes.
   - Import d'un **PDF** (1re page) ou d'une **image** : **lecture automatique**, sans IA (`src/lib/raster.ts`). Les murs coupés (pleins ou hachurés) sont repérés comme des bandes d'épaisseur régulière bordées de deux contours continus, puis suivis à travers les fenêtres (traits fins parallèles) ; portes reconnues à leur arc. Les noms et surfaces écrits sur le plan sont lus par OCR (Tesseract, `src/lib/ocr.ts`, données de langue chargées depuis le CDN jsDelivr) : les pièces sont nommées et l'échelle est déduite des surfaces (« 22,12 m² »). Sinon, échelle estimée d'après l'épaisseur des murs, à vérifier avec l'outil Échelle.
   - Le plan reste affiché en calque : on complète ou corrige à la main (murs, ouvertures, types de pièces), ou on relance « Relire le plan automatiquement ».
   - Outils : mur, porte, fenêtre, baie vitrée, passage, pièce (clic dans une zone fermée), détection de toutes les pièces, annuler / rétablir, enregistrement `.plan3d.json`.
2. **Maison 3D** : maquette (vue en coupe à 1,10 m ou murs entiers), visite libre à hauteur d'yeux (Z Q S D, collisions), **visite guidée** automatique depuis l'entrée, pièce par pièce, casque VR (WebXR), export **GLB**.
3. **Intérieur — design d'espace** : 4 styles (contemporain, afro-chic, minimaliste béton, tropical), ameublement automatique selon le type de pièce, puis aménagement à la main : catalogue de meubles, sélection et déplacement à la souris dans la 3D, rotation (R), dimensions, duplication, suppression ; sol et peinture choisis pièce par pièce. Option « dessin du plan au sol » : le plan importé est plaqué au sol en 3D, à l'échelle (meubles dessinés, jardin, voiture…).

Plans d'essai : `public/exemples/maison-b.{pdf,png,dxf}`, et la villa d'exemple intégrée.

## Code

- `src/lib/` : modèle (`types`, `store`), géométrie, import DXF (`dxf`), détection des pièces (`roomDetect`), ameublement (`furnish`), visite guidée (`tour`), styles, textures procédurales.
- `src/components/editor/Editor2D.tsx` : éditeur SVG.
- `src/components/three/` : maison 3D, mobilier, visionneuse (maquette / visite / guidée / VR / export).

Tout tourne dans le navigateur : aucun serveur, aucune clé d'API (seul l'OCR télécharge ses fichiers de langue depuis jsDelivr au premier usage). Le projet est sauvegardé dans le stockage local du navigateur.

## Rendu IA réaliste (open source, GPU RunPod)

Bouton **Rendu IA** dans la 3D : la vue devient une photo réaliste (Qwen-Image-Edit 2509 + Lightning + Anything2Real, ~20 s),
puis la photo devient une vidéo de 5 s (Wan 2.2 image → vidéo 14B + accélération 4 étapes, ~1 min 30 en 480p, ~4 min en 720p).
Les calculs tournent dans ComfyUI sur un pod RunPod (L40 48 Go testé), joint par un tunnel SSH ; l'app passe par `/api/rendu`
(le navigateur ne parle jamais au pod).

- `.env.local` : `COMFYUI_URL=http://127.0.0.1:18188`
- installation des modèles sur le pod : `scripts/runpod/install_models.py`
- reprise d'une séance après Stop/Start du pod : `scripts/runpod/session.sh <ip> <port>`
- essais en ligne de commande : `scripts/runpod/comfy_run.py photo|video <url> <image>`

## Pistes avec l'IA (clé d'API nécessaire)

- Plans photographiés de travers, dessinés à la main ou très chargés : la lecture sans IA atteint ses limites (murs manquants, pièces fusionnées).
- Propositions d'aménagement et de décoration à partir d'une consigne.
- Rendus photoréalistes des pièces.
