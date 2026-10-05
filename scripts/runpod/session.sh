#!/usr/bin/env bash
# Relance une séance de rendu IA sur le pod RunPod après un Stop / Start.
#   ./session.sh <ip> <port>      (ligne « SSH over exposed TCP » du bouton Connect)
# Réinstalle ce que le disque système a perdu (dépendances, modèles vidéo), démarre ComfyUI
# puis ouvre le tunnel : l'app (COMFYUI_URL=http://127.0.0.1:18188) peut alors faire ses rendus.
set -euo pipefail
IP=${1:?ip du pod}; PORT=${2:?port SSH du pod}
KEY=~/.ssh/runpod_plan3d
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -p "$PORT" "root@$IP")
scp -q -i "$KEY" -P "$PORT" "$(dirname "$0")/install_models.py" "root@$IP:/workspace/install_models.py"
"${SSH[@]}" 'bash -s' <<'REMOTE'
set -e
export PIP_BREAK_SYSTEM_PACKAGES=1 HF_HUB_DISABLE_XET=1
cd /workspace/ComfyUI
grep -v -E "^(torch|torchvision|torchaudio)[=<> ]*" requirements.txt > /tmp/req.txt
pip install -q -r /tmp/req.txt torchsde 2>&1 | grep -v -i warning || true
# modèles vidéo sur le disque système (le volume de 50 Go est plein)
cat > extra_model_paths.yaml <<YAML
systeme:
    base_path: /root/models
    diffusion_models: diffusion_models/
    text_encoders: text_encoders/
    vae: vae/
    loras: loras/
YAML
COMFY=/root python3 /workspace/install_models.py video
pkill -f "^python3 main.py" || true
nohup python3 main.py --listen 127.0.0.1 --port 8188 > /workspace/comfy.log 2>&1 &
for i in $(seq 1 60); do curl -s localhost:8188/system_stats > /dev/null && break; sleep 2; done
echo "ComfyUI prêt"
REMOTE
echo "Tunnel ouvert sur http://127.0.0.1:18188 (Ctrl+C pour fermer)"
exec ssh -i "$KEY" -o BatchMode=yes -o ServerAliveInterval=15 -N -L 18188:127.0.0.1:8188 -p "$PORT" "root@$IP"
