#!/bin/bash
# omp-dev — run omp from the dev branch source tree.
#
# The compiled `omp` binary at ~/.local/bin/omp is left untouched; this
# wrapper always runs whatever is checked out in the source tree, so you
# get your in-progress changes without reinstalling.
set -euo pipefail
exec bun --cwd="/Users/matheus.gois/Projects/oh-my-pi/packages/coding-agent" src/cli.ts "$@"
