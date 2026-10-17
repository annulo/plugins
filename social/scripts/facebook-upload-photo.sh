#!/bin/sh
# stdin is base64 image data. The Page token stays out of argv and stdout.
set -eu
: "${ANNULO_FACEBOOK_PAGE_TOKEN:?Missing Facebook Page token}"
photo_file=$(mktemp "${TMPDIR:-/tmp}/annulo-facebook-photo.XXXXXX")
trap 'rm -f "$photo_file"' EXIT HUP INT TERM
base64 -d > "$photo_file"
printf 'header = "Authorization: Bearer %s"\n' "$ANNULO_FACEBOOK_PAGE_TOKEN" |
  curl --config - --silent --show-error --connect-timeout 20 --max-time 120 \
    --request POST --form "source=@${photo_file};filename=photo;type=$2" \
    --form-string 'published=false' --write-out '\n%{http_code}' "$1"
