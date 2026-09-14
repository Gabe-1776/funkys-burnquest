// Ensures ?debug=1 is present in a tool URL so render3d exposes its debug
// globals (__scene, __renderer, __frogRig, etc.). Required after SECURITY
// REVIEW #15 gated them behind exact ?debug=1: a shipped page no longer
// exposes the handles, so every browser tool must opt in. Applied to both
// the hardcoded default and any caller-supplied --url / $URL so a local or
// live target never silently drops debug=1; existing query params (and any
// fragment) are preserved via the WHATWG URL parser, with a string-append
// fallback for a relative path it cannot parse.
function debugURL(u) {
    if (!u) return u;
    try {
        const url = new URL(u);
        if (url.searchParams.get('debug') !== '1') url.searchParams.set('debug', '1');
        return url.href;
    } catch (e) {
        if (/[?&]debug=1\b/.test(u)) return u;
        return u + (u.includes('?') ? '&' : '?') + 'debug=1';
    }
}
module.exports = debugURL;
