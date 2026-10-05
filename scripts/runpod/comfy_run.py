"""Lance un rendu sur le ComfyUI du pod RunPod et récupère le résultat.

    python comfy_run.py photo  <URL_COMFY> <image.png> [consigne] [--seed N]
    python comfy_run.py video  <URL_COMFY> <image.png> [consigne] [--seed N]

photo : Qwen-Image-Edit 2509 + Lightning 8 étapes + Anything2Real (capture 3D → photo réaliste)
video : Wan 2.2 image → vidéo 14B + accélération 4 étapes (photo → plan de 5 s)
Sans dépendance : bibliothèque standard Python seulement.
"""
import json
import mimetypes
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

PHOTO_PROMPT = (
    "Change the image to a realistic photograph. Turn this 3D render into a real interior photograph: keep exactly the same "
    "room layout, walls, doors, windows, camera angle and furniture positions. Natural daylight through the windows, "
    "soft realistic shadows, real materials (wood parquet, matte painted plaster walls, fabric upholstery), "
    "professional real-estate photography, 24mm lens, high detail."
)
VIDEO_PROMPT = (
    "Slow smooth forward dolly shot through this real house interior, steady camera, natural daylight, "
    "realistic materials, cinematic real-estate video, no people."
)
VIDEO_NEGATIVE = "blurry, distorted geometry, warped walls, flickering, people, text, watermark, low quality, cartoon, 3d render"


def call(base: str, path: str, data: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(base.rstrip("/") + path, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"ComfyUI a refusé la requête {path} ({e.code}) : {e.read().decode()[:3000]}")


def upload(base: str, image: Path) -> str:
    boundary = uuid.uuid4().hex
    mime = mimetypes.guess_type(image.name)[0] or "image/png"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{image.name}\"\r\n"
        f"Content-Type: {mime}\r\n\r\n"
    ).encode() + image.read_bytes() + f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    res = json.loads(call(base, "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}))
    return res["name"]


def photo_workflow(image: str, prompt: str, seed: int) -> dict:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_edit_2509_fp8_e4m3fn.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
        "4": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": "Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors", "strength_model": 1.0}},
        "5": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["4", 0], "lora_name": "Qwen-Image-Edit-2509-Anything2RealAlpha.safetensors", "strength_model": 1.0}},
        "6": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["5", 0], "shift": 3.0}},
        "7": {"class_type": "CFGNorm", "inputs": {"model": ["6", 0], "strength": 1.0}},
        "8": {"class_type": "LoadImage", "inputs": {"image": image}},
        "9": {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": ["8", 0], "upscale_method": "lanczos", "megapixels": 1.0, "resolution_steps": 8}},
        "10": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["2", 0], "prompt": prompt, "vae": ["3", 0], "image1": ["9", 0]}},
        "11": {"class_type": "TextEncodeQwenImageEditPlus", "inputs": {"clip": ["2", 0], "prompt": "", "vae": ["3", 0], "image1": ["9", 0]}},
        "12": {"class_type": "VAEEncode", "inputs": {"pixels": ["9", 0], "vae": ["3", 0]}},
        "13": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["7", 0], "seed": seed, "steps": 8, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
                "positive": ["10", 0], "negative": ["11", 0], "latent_image": ["12", 0], "denoise": 1.0,
            },
        },
        "14": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["3", 0]}},
        "15": {"class_type": "SaveImage", "inputs": {"images": ["14", 0], "filename_prefix": "plan3d/photo"}},
    }


def video_workflow(image: str, prompt: str, seed: int, width: int = 1280, height: int = 720, frames: int = 81) -> dict:
    def expert(uid: str, unet: str, lora: str):
        return {
            f"{uid}a": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
            f"{uid}b": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": [f"{uid}a", 0], "lora_name": lora, "strength_model": 1.0}},
            f"{uid}c": {"class_type": "ModelSamplingSD3", "inputs": {"model": [f"{uid}b", 0], "shift": 5.0}},
        }

    wf = {
        **expert("h", "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"),
        **expert("l", "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"),
        "clip": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "wan_2.1_vae.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": prompt}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["clip", 0], "text": VIDEO_NEGATIVE}},
        "img": {"class_type": "LoadImage", "inputs": {"image": image}},
        "i2v": {
            "class_type": "WanImageToVideo",
            "inputs": {"positive": ["pos", 0], "negative": ["neg", 0], "vae": ["vae", 0], "start_image": ["img", 0],
                       "width": width, "height": height, "length": frames, "batch_size": 1},
        },
        # 4 étapes : 2 avec l'expert « bruit fort » (composition), 2 avec l'expert « bruit faible » (détails)
        "s1": {
            "class_type": "KSamplerAdvanced",
            "inputs": {"model": ["hc", 0], "add_noise": "enable", "noise_seed": seed, "steps": 4, "cfg": 1.0, "sampler_name": "euler",
                       "scheduler": "simple", "positive": ["i2v", 0], "negative": ["i2v", 1], "latent_image": ["i2v", 2],
                       "start_at_step": 0, "end_at_step": 2, "return_with_leftover_noise": "enable"},
        },
        "s2": {
            "class_type": "KSamplerAdvanced",
            "inputs": {"model": ["lc", 0], "add_noise": "disable", "noise_seed": seed, "steps": 4, "cfg": 1.0, "sampler_name": "euler",
                       "scheduler": "simple", "positive": ["i2v", 0], "negative": ["i2v", 1], "latent_image": ["s1", 0],
                       "start_at_step": 2, "end_at_step": 10000, "return_with_leftover_noise": "disable"},
        },
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["s2", 0], "vae": ["vae", 0]}},
        "vid": {"class_type": "CreateVideo", "inputs": {"images": ["dec", 0], "fps": 16}},
        "save": {"class_type": "SaveVideo", "inputs": {"video": ["vid", 0], "filename_prefix": "plan3d/video", "format": "auto"}},
    }
    return wf


def check_nodes(base: str, wf: dict):
    """Vérifie que les nœuds existent et complète les réglages obligatoires absents par leur valeur par défaut
    (les versions récentes de ComfyUI ajoutent parfois des réglages)."""
    info = json.loads(call(base, "/object_info"))
    missing = sorted({n["class_type"] for n in wf.values()} - set(info))
    if missing:
        sys.exit(f"Nœuds absents sur ce ComfyUI (mettre ComfyUI à jour) : {', '.join(missing)}")
    for node in wf.values():
        required = info[node["class_type"]]["input"].get("required", {})
        for name, spec in required.items():
            if name in node["inputs"]:
                continue
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            if "default" in opts:
                node["inputs"][name] = opts["default"]
            elif isinstance(spec[0], list) and spec[0]:
                node["inputs"][name] = spec[0][0]
            elif opts.get("options"):
                first = opts["options"][0]
                node["inputs"][name] = first["key"] if isinstance(first, dict) else first


def run(base: str, wf: dict, out_dir: Path) -> list[Path]:
    check_nodes(base, wf)
    client = uuid.uuid4().hex
    res = json.loads(call(base, "/prompt", json.dumps({"prompt": wf, "client_id": client}).encode(), {"Content-Type": "application/json"}))
    pid = res["prompt_id"]
    t0 = time.time()
    last = 0.0
    while True:
        try:
            hist = json.loads(call(base, f"/history/{pid}"))
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            # tunnel ou réseau coupé un instant : on réessaie (le calcul continue sur le pod)
            print(f"  connexion perdue ({e}), nouvel essai…", flush=True)
            time.sleep(10)
            continue
        if time.time() - last > 30:
            print(f"  en cours… {time.time() - t0:.0f} s", flush=True)
            last = time.time()
        if pid in hist:
            h = hist[pid]
            if h.get("status", {}).get("status_str") == "error":
                sys.exit("Erreur ComfyUI : " + json.dumps(h["status"].get("messages", [])[-1:], ensure_ascii=False)[:2000])
            break
        time.sleep(3)
    took = time.time() - t0
    files = []
    for node in h["outputs"].values():
        for kind in ("images", "videos", "gifs", "animated"):
            for f in node.get(kind, []) or []:
                if not isinstance(f, dict) or "filename" not in f:
                    continue
                q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
                dest = out_dir / f["filename"]
                dest.write_bytes(call(base, f"/view?{q}"))
                files.append(dest)
    print(f"terminé en {took:.0f} s → " + ", ".join(str(p) for p in files))
    return files


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    seed = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else random.randint(1, 2**31)
    if "--seed" in sys.argv:
        args.remove(str(seed))
    size = sys.argv[sys.argv.index("--size") + 1] if "--size" in sys.argv else "1280x720"
    if "--size" in sys.argv:
        args.remove(size)
    mode, base, image = args[0], args[1], Path(args[2])
    prompt = args[3] if len(args) > 3 else (PHOTO_PROMPT if mode == "photo" else VIDEO_PROMPT)
    name = upload(base, image)
    w, h = (int(v) for v in size.split("x"))
    wf = photo_workflow(name, prompt, seed) if mode == "photo" else video_workflow(name, prompt, seed, w, h)
    out = Path(__file__).resolve().parent / "sorties"
    out.mkdir(exist_ok=True)
    run(base, wf, out)
