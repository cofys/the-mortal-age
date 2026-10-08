// The Settings "Screen brightness" on a lit surface (texel x vertex colour). u_brightness is
// OSRS's gamma exponent (lower is brighter). Flat colours already carry it (hslToRgb); textures
// get the same change relative to the gamma the scene was tuned at, so that look is unchanged at
// the default and a brighter setting brightens textures as well.
const float TUNED_BRIGHTNESS = 0.8;

vec3 applyBrightness(vec3 texel, vec3 lit) {
    vec3 regamma = pow(max(texel, vec3(1.0 / 255.0)), vec3(u_brightness - TUNED_BRIGHTNESS));
    return texel * regamma * lit * TUNED_BRIGHTNESS;
}
