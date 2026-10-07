"""Installe les modèles des rendus Plan3D dans ComfyUI, sur un pod RunPod.

    python install_models.py              # photo + visite fidèle (≈ 75 Go) : image + controle
    python install_models.py image        # photo réaliste seulement (Qwen-Image-Edit 2511, ≈ 31 Go)
    python install_models.py controle     # vidéo qui suit la profondeur de la visite (Wan 2.2 Fun Control, ≈ 39 Go)
    python install_models.py video        # vidéo libre depuis une photo (Wan 2.2 image → vidéo, ≈ 39 Go)
    python install_models.py tout
    COMFY=/workspace LAYOUT=serverless python install_models.py   # volume réseau pour RunPod Serverless

Les modèles vont sur le volume persistant (/workspace) s'il existe, pour survivre à l'arrêt du pod.
Un fichier déjà présent (même nom) n'est pas retéléchargé ; l'app choisit d'elle-même parmi les modèles du pod.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

# on garde la version de huggingface_hub déjà installée : transformers (donc ComfyUI) en exige une précise
try:
    import huggingface_hub  # noqa: F401
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "huggingface_hub"], check=True)
os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
from huggingface_hub import hf_hub_download  # noqa: E402

WAN = "Comfy-Org/Wan_2.2_ComfyUI_Repackaged"
# (dépôt, fichier, dossier ComfyUI, groupes)
FILES = [
    # photo réaliste : Qwen-Image-Edit 2511 (Apache 2.0) + Lightning 8 étapes
    ("Comfy-Org/Qwen-Image-Edit_ComfyUI", "split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors", "diffusion_models", {"image"}),
    ("Comfy-Org/Qwen-Image_ComfyUI", "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors", "text_encoders", {"image"}),
    ("Comfy-Org/Qwen-Image_ComfyUI", "split_files/vae/qwen_image_vae.safetensors", "vae", {"image"}),
    ("lightx2v/Qwen-Image-Edit-2511-Lightning", "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors", "loras", {"image"}),
    # LoRA « tout en photo réelle », faite pour 2509 : à comparer avec QWEN_ANYTHING2REAL=0 côté app
    ("Comfy-Org/Qwen-Image-Edit_ComfyUI", "split_files/loras/Qwen-Image-Edit-2509-Anything2RealAlpha.safetensors", "loras", {"image"}),
    # vidéo guidée par la profondeur : Wan 2.2 Fun Control 14B (Apache 2.0), deux experts
    (WAN, "split_files/diffusion_models/wan2.2_fun_control_high_noise_14B_fp8_scaled.safetensors", "diffusion_models", {"controle"}),
    (WAN, "split_files/diffusion_models/wan2.2_fun_control_low_noise_14B_fp8_scaled.safetensors", "diffusion_models", {"controle"}),
    # vidéo libre depuis une photo : Wan 2.2 image → vidéo 14B (Apache 2.0)
    (WAN, "split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", "diffusion_models", {"video"}),
    (WAN, "split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", "diffusion_models", {"video"}),
    # communs aux deux vidéos : accélération 4 étapes, encodeur de texte, VAE
    (WAN, "split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors", "loras", {"controle", "video"}),
    (WAN, "split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors", "loras", {"controle", "video"}),
    (WAN, "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", "text_encoders", {"controle", "video"}),
    (WAN, "split_files/vae/wan_2.1_vae.safetensors", "vae", {"controle", "video"}),
    # qualité max : images intermédiaires (32 images/s) ; SeedVR2 se télécharge seul au premier usage
    ("Comfy-Org/frame_interpolation", "frame_interpolation/rife_v4.26.safetensors", "frame_interpolation", {"controle"}),
]
GROUPS = {"image": {"image"}, "controle": {"controle"}, "video": {"video"}, "tout": {"image", "controle", "video"}}


def comfy_models_dir() -> Path:
    """Dossier models/ de ComfyUI, sur le volume persistant si possible."""
    for root in (Path("/workspace/ComfyUI"), Path("/workspace/comfyui"), Path("/ComfyUI"), Path("/comfyui")):
        if (root / "main.py").exists():
            if str(root).startswith("/workspace"):
                return root / "models"
            # ComfyUI hors du volume : modèles sur /workspace, déclarés dans extra_model_paths.yaml
            target = Path("/workspace/models")
            yaml = root / "extra_model_paths.yaml"
            block = "plan3d:\n    base_path: /workspace/models\n" + "".join(
                f"    {d}: {d}/\n" for d in ("diffusion_models", "text_encoders", "vae", "loras")
            )
            if "plan3d:" not in (yaml.read_text() if yaml.exists() else ""):
                with yaml.open("a") as f:
                    f.write("\n" + block)
            return target
    sys.exit("ComfyUI introuvable : indiquez son dossier avec COMFY=/chemin")


models = Path(os.environ["COMFY"]) / "models" if "COMFY" in os.environ else comfy_models_dir()
# RunPod Serverless (worker-comfyui) : le volume réseau est lu dans models/unet et models/clip
SERVERLESS = os.environ.get("LAYOUT") == "serverless"
RENAME = {"diffusion_models": "unet", "text_encoders": "clip"} if SERVERLESS else {}
arg = sys.argv[1] if len(sys.argv) > 1 else None
if arg and arg not in GROUPS:
    sys.exit(f"groupe inconnu : {arg} (au choix : {', '.join(GROUPS)})")
wanted = GROUPS[arg] if arg else {"image", "controle"}
tmp = Path(os.environ.get("HF_TMP", str(models.parent / ".hf-tmp")))  # même disque que les modèles
for repo, file, folder, groups in FILES:
    if not groups & wanted:
        continue
    folder = RENAME.get(folder, folder)
    dest = models / folder / Path(file).name
    # déjà présent ici ou dans le ComfyUI du volume persistant
    if dest.exists() or (Path("/workspace/ComfyUI/models") / folder / Path(file).name).exists():
        print(f"déjà là   {dest.name}")
        continue
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"télécharge {dest.name} …", flush=True)
    path = hf_hub_download(repo, file, local_dir=tmp)
    shutil.move(path, dest)
    print(f"ok        {dest.name} ({dest.stat().st_size / 1e9:.1f} Go)", flush=True)
shutil.rmtree(tmp, ignore_errors=True)
print("Modèles installés dans", models)
