# oh-my-pi Makefile — manage the dev `omp-dev` CLI.
#
# The `omp-dev` wrapper runs `bun ... src/cli.ts` directly from this
# checkout, so it always reflects whatever is on the current branch
# (use `git checkout dev`). No compile step is needed for it to work.
#
# Usage:
#   make install      # install the `omp-dev` wrapper at ~/.local/bin/omp-dev
#   make reinstall     # rebuild natives (if stale) + reinstall wrapper
#   make run           # run omp directly from source (no install needed)
#   make build         # compile a standalone binary (slow; optional)
#   make natives       # build only the native addons (Rust + TS)
#   make check         # type-check the coding-agent package
#   make clean         # remove build artifacts
#   make uninstall     # remove the `omp-dev` wrapper
#
# The original compiled `omp` at ~/.local/bin/omp is left untouched.

CWD        := $(CURDIR)
PKG        := $(CWD)/packages/coding-agent
NATIVES    := $(CWD)/packages/natives
BIN_DIR    := $(HOME)/.local/bin
WRAPPER    := $(BIN_DIR)/omp-dev
WRAPPER_SRC := $(CWD)/scripts/omp-dev.sh
NODE_ARTIFACT := $(NATIVES)/native/pi_natives.darwin-arm64.node

.PHONY: install reinstall run build natives check clean uninstall

# Install (or refresh) the wrapper. Fast — no compile.
install:
	@mkdir -p $(BIN_DIR)
	@cp $(WRAPPER_SRC) $(WRAPPER)
	@chmod +x $(WRAPPER)
	@echo "✓ Installed $(WRAPPER)"
	@echo "  Run it with: omp-dev"

# Rebuild natives if missing, then install the wrapper.
reinstall: natives install

# Run omp directly from the source tree (no build, no install).
run:
	@exec bun --cwd=$(PKG) src/cli.ts

# Build only the native addons. Skips the ~50s Rust compile if the
# .node artifact already exists (run `make clean && make natives` to force).
natives:
	@if [ -f "$(NODE_ARTIFACT)" ]; then \
		echo "✓ Natives already built — skipping"; \
		echo "  (run 'make clean && make natives' to force a rebuild)"; \
	else \
		echo "→ Building natives…"; \
		cd $(NATIVES) && bun run build; \
	fi

# Compile a standalone omp binary. Slow (Bun compile). Optional — the
# wrapper works without it. Output lands in packages/coding-agent/dist/.
build: natives
	@echo "→ Building coding-agent binary…"
	@cd $(PKG) && bun run build
	@echo "✓ Build complete"

check:
	@cd $(CWD) && bun check

clean:
	@echo "→ Cleaning build artifacts…"
	@rm -rf $(PKG)/dist $(CWD)/dist $(NATIVES)/build 2>/dev/null || true
	@echo "✓ Clean"

uninstall:
	@rm -f $(WRAPPER)
	@echo "✓ Removed $(WRAPPER)"
