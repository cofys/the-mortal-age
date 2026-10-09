// Generated from 117HD/RLHD scene/materials.json. See textures/000_licenses.txt.
// Optional local material sources: textures/local/sources.json.
import carpet from "./textures/carpet.jpg";
import carpet_n from "./textures/carpet_n.png";
import castle_brick_01_color from "./textures/local/castle_brick_01_color.webp";
import castle_brick_01_normal from "./textures/local/castle_brick_01_normal.webp";
import cobblestone_floor_02_color from "./textures/local/cobblestone_floor_02_color.webp";
import cobblestone_floor_02_normal from "./textures/local/cobblestone_floor_02_normal.webp";
import fortis_roads from "./textures/fortis_roads.jpg";
import grass_path_2_color from "./textures/local/grass_path_2_color.webp";
import grass_path_2_normal from "./textures/local/grass_path_2_normal.webp";
import gravel_ground_01_color from "./textures/local/gravel_ground_01_color.webp";
import gravel_ground_01_normal from "./textures/local/gravel_ground_01_normal.webp";
import hd_concrete from "./textures/hd_concrete.jpg";
import hd_concrete_n from "./textures/hd_concrete_n.png";
import hd_crate from "./textures/hd_crate.jpg";
import hd_crate_n from "./textures/hd_crate_n.png";
import hd_hay from "./textures/hd_hay.jpg";
import hd_hay_n from "./textures/hd_hay_n.png";
import hd_infernal_cape from "./textures/hd_infernal_cape.jpg";
import hd_iron_bars from "./textures/hd_iron_bars.png";
import hd_lava_3 from "./textures/hd_lava_3.jpg";
import hd_sand_brick from "./textures/hd_sand_brick.jpg";
import hd_sand_brick_n from "./textures/hd_sand_brick_n.png";
import marble_4 from "./textures/marble_4.jpg";
import marble_4_n from "./textures/marble_4_n.png";
import red_brick_03_color from "./textures/local/red_brick_03_color.webp";
import red_brick_03_normal from "./textures/local/red_brick_03_normal.webp";
import rock_1 from "./textures/rock_1.jpg";
import rock_1_n from "./textures/rock_1_n.png";
import roof_09_color from "./textures/local/roof_09_color.webp";
import roof_09_normal from "./textures/local/roof_09_normal.webp";
import roof_slates_02_color from "./textures/local/roof_slates_02_color.webp";
import roof_slates_02_normal from "./textures/local/roof_slates_02_normal.webp";
import sand_02_color from "./textures/local/sand_02_color.webp";
import sand_02_normal from "./textures/local/sand_02_normal.webp";
import snow_1 from "./textures/snow_1.jpg";
import snow_1_n from "./textures/snow_1_n.png";
import sparse_grass_color from "./textures/local/sparse_grass_color.webp";
import thatch_roof_angled_color from "./textures/local/thatch_roof_angled_color.webp";
import thatch_roof_angled_normal from "./textures/local/thatch_roof_angled_normal.webp";
import tiles_2x2_2 from "./textures/tiles_2x2_2.jpg";
import tiles_2x2_2_n from "./textures/tiles_2x2_2_n.png";
import weathered_planks_color from "./textures/local/weathered_planks_color.webp";
import weathered_planks_normal from "./textures/local/weathered_planks_normal.webp";
import web from "./textures/web.png";
import worn_tiles from "./textures/worn_tiles.jpg";
import worn_tiles_n from "./textures/worn_tiles_n.png";
export const HD_DETAIL_TEXTURES: string[] = [castle_brick_01_color, sparse_grass_color, thatch_roof_angled_color];
export interface HdMaterial { id: number; file: string | null; normal: string | null; params: number[]; unlit: boolean; worldUv: boolean; brightness: number; }
export const HD_MATERIALS: HdMaterial[] = [
    { id: 2, file: castle_brick_01_color, normal: castle_brick_01_normal, params: [0.04, 25.0, 2, 2], unlit: false, worldUv: true, brightness: 1 },
    { id: 3, file: weathered_planks_color, normal: weathered_planks_normal, params: [0.04, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 6, file: roof_09_color, normal: roof_09_normal, params: [0, 40.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 8, file: null, normal: null, params: [0, 1, 1.025, 1.025], unlit: false, worldUv: false, brightness: 1 },
    { id: 11, file: hd_concrete, normal: hd_concrete_n, params: [0.04, 20.0, 1, 1], unlit: false, worldUv: false, brightness: 0.881 },
    { id: 12, file: hd_iron_bars, normal: null, params: [0.6, 30.0, 0.98, 1.0], unlit: false, worldUv: false, brightness: 1 },
    { id: 15, file: marble_4, normal: marble_4_n, params: [0, 1, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 16, file: thatch_roof_angled_color, normal: thatch_roof_angled_normal, params: [0, 20.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 18, file: hd_hay, normal: hd_hay_n, params: [0, 15.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 22, file: hd_crate, normal: hd_crate_n, params: [0.04, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 0.955 },
    { id: 23, file: red_brick_03_color, normal: red_brick_03_normal, params: [0.04, 20.0, 2, 2], unlit: false, worldUv: true, brightness: 1 },
    { id: 26, file: web, normal: null, params: [0, 1, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 30, file: null, normal: null, params: [0, 1, 1.025, 1.0], unlit: false, worldUv: false, brightness: 1 },
    { id: 31, file: hd_lava_3, normal: null, params: [0, 1, 1, 1], unlit: true, worldUv: false, brightness: 1 },
    { id: 33, file: null, normal: null, params: [0, 1, 1.3, 1.025], unlit: false, worldUv: false, brightness: 1 },
    { id: 34, file: null, normal: null, params: [0, 1, 1, 1], unlit: true, worldUv: false, brightness: 1 },
    { id: 35, file: hd_sand_brick, normal: hd_sand_brick_n, params: [0.04, 20.0, 1, 1], unlit: false, worldUv: false, brightness: 0.881 },
    { id: 40, file: null, normal: null, params: [0, 1, 1, 1], unlit: true, worldUv: false, brightness: 1 },
    { id: 41, file: null, normal: null, params: [0, 1, 1.025, 1.025], unlit: false, worldUv: false, brightness: 1 },
    { id: 42, file: null, normal: null, params: [1.0, 400.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 44, file: roof_slates_02_color, normal: roof_slates_02_normal, params: [0, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 45, file: roof_09_color, normal: roof_09_normal, params: [0, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 46, file: cobblestone_floor_02_color, normal: cobblestone_floor_02_normal, params: [0.04, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 50, file: null, normal: null, params: [0, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 55, file: null, normal: null, params: [0, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 59, file: hd_infernal_cape, normal: null, params: [0, 1, 1, 1], unlit: true, worldUv: false, brightness: 1 },
    { id: 90, file: null, normal: null, params: [0, 1, 1.025, 1.025], unlit: false, worldUv: false, brightness: 1 },
    { id: 121, file: fortis_roads, normal: null, params: [0, 1, -1, -1], unlit: false, worldUv: false, brightness: 0.92 },
    { id: 122, file: null, normal: null, params: [0, 1, -1, -1], unlit: false, worldUv: false, brightness: 0.92 },
];
export const HD_GROUND_MATERIALS: HdMaterial[] = [
    { id: 1, file: sparse_grass_color, normal: null, params: [0, 1, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 2, file: grass_path_2_color, normal: grass_path_2_normal, params: [0, 18.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 3, file: sand_02_color, normal: sand_02_normal, params: [0, 10.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 4, file: gravel_ground_01_color, normal: gravel_ground_01_normal, params: [0, 130.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 5, file: rock_1, normal: rock_1_n, params: [0, 45.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 6, file: snow_1, normal: snow_1_n, params: [0.04, 20.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 7, file: weathered_planks_color, normal: weathered_planks_normal, params: [0.04, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 8, file: carpet, normal: carpet_n, params: [0, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 9, file: castle_brick_01_color, normal: castle_brick_01_normal, params: [0.04, 25.0, 2, 2], unlit: false, worldUv: true, brightness: 1 },
    { id: 10, file: red_brick_03_color, normal: red_brick_03_normal, params: [0.04, 20.0, 2, 2], unlit: false, worldUv: true, brightness: 1 },
    { id: 11, file: marble_4, normal: marble_4_n, params: [0, 1, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 12, file: tiles_2x2_2, normal: tiles_2x2_2_n, params: [0.3, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 13, file: cobblestone_floor_02_color, normal: cobblestone_floor_02_normal, params: [0.04, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 14, file: hd_concrete, normal: hd_concrete_n, params: [0.04, 20.0, 1, 1], unlit: false, worldUv: false, brightness: 0.881 },
    { id: 15, file: hd_sand_brick, normal: hd_sand_brick_n, params: [0.04, 20.0, 1, 1], unlit: false, worldUv: false, brightness: 0.881 },
    { id: 16, file: worn_tiles, normal: worn_tiles_n, params: [0.04, 25.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 17, file: cobblestone_floor_02_color, normal: cobblestone_floor_02_normal, params: [0.04, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
    { id: 18, file: cobblestone_floor_02_color, normal: cobblestone_floor_02_normal, params: [0.04, 30.0, 1, 1], unlit: false, worldUv: false, brightness: 1 },
];
