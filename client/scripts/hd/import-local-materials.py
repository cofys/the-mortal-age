"""Prepare the local CC0 pack from downloaded Poly Haven 1K maps.

Requires Pillow and NumPy. Source folders contain download.json from the file API.
Usage: python3 import-local-materials.py /path/to/hd-material-sources
Then rerun import-materials.py to publish the material table.
"""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

SIZE = 256
source = Path(sys.argv[1])
script = Path(__file__).resolve().parent
target = script.parents[1] / 'game/plugins/hd/textures/local'
target.mkdir(exist_ok=True)
definitions = json.loads((script / 'local-materials.json').read_text())['assets']
records = []

def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'TSPS-local-material-import/1.0'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()

for definition in definitions:
    asset = definition['asset']
    folder = source / asset
    folder.mkdir(parents=True, exist_ok=True)
    cached = folder / 'download.json'
    if cached.exists():
        downloads = json.loads(cached.read_text())
    else:
        files = json.loads(download(f'https://api.polyhaven.com/files/{asset}'))
        downloads = {}
        for channel in ['Diffuse', 'nor_gl']:
            if channel == 'nor_gl' and not definition.get('normal', True):
                continue
            variants = files[channel]['1k']
            extension = 'png' if 'png' in variants else 'jpg'
            item = variants[extension]
            path = folder / f'{channel}.{extension}'
            path.write_bytes(download(item['url']))
            downloads[channel] = {'url': item['url'], 'path': str(path)}
        cached.write_text(json.dumps(downloads, indent=2))
    output = {}
    for channel in ['Diffuse', 'nor_gl']:
        if channel == 'nor_gl' and not definition.get('normal', True):
            continue
        downloaded = downloads[channel]
        size = definition.get('colorSize', SIZE) if channel == 'Diffuse' else SIZE
        assert size in (256, 512), 'Only the two supported atlas sizes may be exported'
        image = Image.open(folder / Path(downloaded['path']).name).convert('RGB').resize((size, size), Image.Resampling.LANCZOS)
        pixels = np.asarray(image, dtype=np.float32) / 255
        if channel == 'nor_gl':
            vectors = pixels * 2 - 1
            vectors[:, :, :2] *= definition.get('normalStrength', 1)
            vectors /= np.maximum(np.linalg.norm(vectors, axis=2, keepdims=True), 1e-6)
            pixels = (vectors + 1) / 2
            # The existing 117 HD shader expects signed X/Y and unsigned Z.
            pixels[:, :, 2] = np.maximum(vectors[:, :, 2], 0)
            suffix = 'normal'
        else:
            luma = pixels @ np.array([0.2126, 0.7152, 0.0722])
            if definition.get('neutralGround'):
                # Terrain already carries its cache hue. Keep the photograph's
                # detail without applying its earth/grass colour a second time.
                # Remove broad photographic patches while retaining blade/grain
                # contrast. Wrap the blur so filtering preserves tileable edges.
                gray = Image.fromarray(np.rint(luma * 255).astype(np.uint8))
                wrapped = Image.new('L', (size * 3, size * 3))
                for y in range(3):
                    for x in range(3):
                        wrapped.paste(gray, (x * size, y * size))
                smooth = wrapped.filter(ImageFilter.GaussianBlur(size / 16)).crop((size, size, size * 2, size * 2))
                low = np.asarray(smooth, dtype=np.float32) / 255
                detail = luma / np.maximum(low, 0.01)
                detail *= (low / max(float(low.mean()), 0.01)) ** 0.15
                detail = np.clip(detail, 0.45, 1.35)
                pixels = np.repeat((0.79 + (detail - 1) * 0.6)[:, :, None], 3, axis=2)
            else:
                pixels = luma[:, :, None] + (pixels - luma[:, :, None]) * definition.get('saturation', 1)
                pixels *= definition.get('exposure', 1)
            suffix = 'color'
        image = Image.fromarray(np.rint(np.clip(pixels, 0, 1) * 255).astype(np.uint8))
        path = target / f'{asset}_{suffix}.webp'
        # Lossless vector maps avoid block artefacts in lighting. Albedo can use
        # compact lossy WebP; neither changes the decoded atlas dimensions.
        image.save(path, 'WEBP', lossless=channel == 'nor_gl', quality=90, method=6)
        output[suffix] = {
            'file': f'local/{path.name}', 'size': size, 'bytes': path.stat().st_size,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'sourceUrl': downloaded['url'],
        }
        assert Image.open(path).size == (size, size)
    records.append({
        'asset': asset, 'url': f'https://polyhaven.com/a/{asset}',
        'license': 'CC0-1.0', 'materials': definition['materials'], 'maps': output,
        **{key: definition[key] for key in ('worldUv', 'textureScale') if key in definition},
    })

(target / 'sources.json').write_text(json.dumps({'size': SIZE, 'assets': records}, indent=2) + '\n')
print(f"Prepared {len(records)} materials; {sum(m['bytes'] for r in records for m in r['maps'].values()):,} download bytes")
