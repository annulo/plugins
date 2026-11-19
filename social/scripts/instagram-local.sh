#!/bin/sh
# Nonsecret arguments only. A mkdir claim is atomic across Annulo runners.
set -eu
case "$1" in
  claim) if mkdir "$2" 2>/dev/null; then printf created; elif [ -d "$2" ]; then printf exists; else exit 1; fi ;;
  release) rmdir "$2" ;;
  upload)
    ig_image=$(mktemp "${TMPDIR:-/tmp}/annulo-instagram-image.XXXXXX")
    trap 'rm -f "$ig_image"' EXIT HUP INT TERM
    base64 -d > "$ig_image"
    creght upload --site_id="$2" --file="$ig_image" --name=instagram.jpg --mimetype=image/jpeg --json
    ;;
  *) exit 2 ;;
esac
