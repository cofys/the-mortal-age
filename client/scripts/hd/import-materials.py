"""Refresh the bundled 117 HD materials: python3 import-materials.py /path/to/RLHD."""
import json
import shutil
import sys
from pathlib import Path

source = Path(sys.argv[1])
scene = source / 'src/main/resources/rs117/hd/scene'
target = Path(__file__).resolve().parents[2] / 'game/plugins/hd'
materials = json.loads((scene / 'materials.json').read_text())
by_name = {m['name']: m for m in materials}
local_manifest = target / 'textures/local/sources.json'
local_overrides = {}
if local_manifest.exists():
    for item in json.loads(local_manifest.read_text())['assets']:
        for name in item['materials']:
            local_overrides[name] = item

def inherited(m):
    return {**(inherited(by_name[m['parent']]) if m.get('parent') in by_name else {}), **m}

imports = {}
def asset(name):
    for extension in ['png', 'jpg']:
        path = scene / 'textures' / (name.lower() + '.' + extension)
        if path.exists():
            imports[name.lower()] = path
            return name.lower()
    return None

def entry(m, id):
    m = inherited(m)
    file = asset(m['name'])
    normal = asset(m.get('normalMap', '')) if file else None
    if m['name'] in local_overrides:
        maps = local_overrides[m['name']]['maps']
        def local_asset(channel):
            if channel not in maps:
                return None
            path = target / 'textures' / maps[channel]['file']
            name = path.stem
            imports[name] = path
            return name
        file = local_asset('color')
        normal = local_asset('normal')
    override = local_overrides.get(m['name'], {})
    scale = override.get('textureScale', m.get('textureScale', [1, 1, 1]))
    specular = m.get('specularStrength', 0)
    # Dry natural surfaces have no broad sheen. Keep polished/glass/metal
    # materials reflective, and only a faint highlight on rough architecture.
    # Wooden roofs use SIMPLE_GRAIN_WOOD (cache texture 16), rather than a
    # material with ROOF in its name. Even weak reflections wash out this wood.
    if m['name'] in {'GRASS_1', 'DIRT_1', 'SAND_1', 'GRAVEL', 'ROCK_1', 'CARPET', 'HD_HAY', 'HD_SIMPLE_GRAIN_WOOD'} or 'ROOF' in m['name']:
        specular = 0
    elif m['name'] in {'SNOW_1', 'HD_WOOD_PLANKS_1', 'HD_CRATE',
                       'HD_BRICK', 'HD_BRICK_BROWN', 'HD_CONCRETE', 'HD_SAND_BRICK',
                       'HD_STONE_PATTERN', 'WORN_TILES', 'FALADOR_PATH_BRICK', 'JAGGED_STONE_TILE'}:
        specular = min(specular, 0.04)
    return {'id': id, 'file': file, 'normal': normal, 'params': [specular, m.get('specularGloss', 1), scale[0], scale[1]], 'unlit': m.get('unlit', False), 'worldUv': override.get('worldUv', False), 'brightness': m.get('brightness', 1)}

# Preserve cache UVs and animation for materials without a replacement. Water
# remains owned by the existing water renderer, including water on models.
water = {1, 24, 25, 52, 53, 54, 57}
entries = []
for m in materials:
    if 'vanillaTextureIndex' not in m or m['vanillaTextureIndex'] in water:
        continue
    replacements = [r for r in materials if m['name'] in r.get('materialsToReplace', []) and r.get('replacementCondition') == 'modelTextures']
    replacement = replacements[0] if replacements else m
    if m['name'] == 'INFERNAL_CAPE' and 'HD_INFERNAL_CAPE' in by_name:
        replacement = by_name['HD_INFERNAL_CAPE']
    item = entry(replacement, m['vanillaTextureIndex'])
    if item['file'] or item['unlit'] or item['params'] != [0, 1, 1, 1]:
        entries.append(item)

# This order matches HdGroundMaterial. Untextured terrain encodes the ID in U.
ground = [entry(by_name[name], i + 1) for i, name in enumerate([
    'GRASS_1', 'DIRT_1', 'SAND_1', 'GRAVEL', 'ROCK_1', 'SNOW_1', 'HD_WOOD_PLANKS_1',
    'CARPET', 'HD_BRICK', 'HD_BRICK_BROWN', 'MARBLE_4', 'TILES_2X2_2',
    'HD_STONE_PATTERN', 'HD_CONCRETE', 'HD_SAND_BRICK', 'WORN_TILES',
    'FALADOR_PATH_BRICK', 'JAGGED_STONE_TILE',
])]
lines = ['// Generated from 117HD/RLHD scene/materials.json. See textures/000_licenses.txt.',
         '// Optional local material sources: textures/local/sources.json.']
used = {row[key] for row in entries + ground for key in ['file', 'normal'] if row[key]}
for name, path in sorted(imports.items()):
    if name not in used:
        continue
    if path.is_relative_to(target):
        relative = path.relative_to(target)
    else:
        shutil.copyfile(path, target / 'textures' / path.name)
        relative = Path('textures') / path.name
    lines.append(f'import {name} from "./{relative}";')
detail = sorted({Path(item['maps']['color']['file']).stem for item in local_overrides.values() if item['maps']['color'].get('size', 256) == 512})
lines.append('export const HD_DETAIL_TEXTURES: string[] = [' + ', '.join(name for name in detail if name in used) + '];')
lines.append('export interface HdMaterial { id: number; file: string | null; normal: string | null; params: number[]; unlit: boolean; worldUv: boolean; brightness: number; }')

def emit(name, rows):
    lines.append(f'export const {name}: HdMaterial[] = [')
    for row in rows:
        fields = [f'{k}: {v if k in ["file", "normal"] and v else json.dumps(v)}' for k, v in row.items()]
        lines.append('    { ' + ', '.join(fields) + ' },')
    lines.append('];')

emit('HD_MATERIALS', entries)
emit('HD_GROUND_MATERIALS', ground)
(target / 'HdMaterialData.ts').write_text('\n'.join(lines) + '\n')
shutil.copyfile(scene / 'textures/000_licenses.txt', target / 'textures/000_licenses.txt')
shutil.copyfile(source / 'LICENSE', target / 'textures/LICENSE-117HD.txt')
print(f'Imported {len(entries)} cache materials, {len(ground)} ground materials and {len(used)} textures')
