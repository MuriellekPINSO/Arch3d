"""Installe les modèles des tests Plan3D dans ComfyUI, sur un pod RunPod.

    python install_models.py            # tout (≈ 70 Go)
    python install_models.py image      # seulement la photo réaliste (Qwen-Image-Edit)
    python install_models.py video      # seulement la vidéo (Wan 2.2)
    COMFY=/workspace LAYOUT=serverless python install_models.py   # volume réseau pour RunPod Serverless

Les modèles vont sur le volume persistant (/workspace) pour survivre à l'arrêt du pod.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "huggingface_hub[hf_transfer]"], check=True)
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
from huggingface_hub import hf_hub_download  # noqa: E402

# (dépôt, fichier, dossier ComfyUI, groupe)
FILES = [
    # photo réaliste : Qwen-Image-Edit 2509 (Apache 2.0)
    ("Comfy-Org/Qwen-Image-Edit_ComfyUI", "split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors", "diffusion_models", "image"),
    ("Comfy-Org/Qwen-Image_ComfyUI", "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors", "text_encoders", "image"),
    ("Comfy-Org/Qwen-Image_ComfyUI", "split_files/vae/qwen_image_vae.safetensors", "vae", "image"),
    ("lightx2v/Qwen-Image-Lightning", "Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors", "loras", "image"),
    ("Comfy-Org/Qwen-Image-Edit_ComfyUI", "split_files/loras/Qwen-Image-Edit-2509-Anything2RealAlpha.safetensors", "loras", "image"),
    # vidéo : Wan 2.2 image → vidéo 14B (Apache 2.0), deux experts + accélération 4 étapes
    ("Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", "diffusion_models", "video"),
    ("Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", "diffusion_models", "video"),
    ("Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors", "loras", "video"),
    ("Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors", "loras", "video"),
    ("Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", "text_encoders", "video"),
    ("Comfy-Org/Wan_2.2_ComfyUI_Repackaged", "split_files/vae/wan_2.1_vae.safetensors", "vae", "video"),
]


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
group = sys.argv[1] if len(sys.argv) > 1 else None
tmp = Path(os.environ.get("HF_TMP", str(models.parent / ".hf-tmp")))  # même disque que les modèles
for repo, file, folder, g in FILES:
    if group and g != group:
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
