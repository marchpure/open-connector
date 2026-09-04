#!/bin/sh
set -eu

bucket=${1:?usage: provision-tos.sh BUCKET_NAME}
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$root/tools/provision-tos.mjs" "$bucket"
