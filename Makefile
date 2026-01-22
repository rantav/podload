.PHONY: setup install lint test typecheck check dev install-mac

setup: install

install:
	pnpm install

lint:
	pnpm run lint

test:
	pnpm run test

typecheck:
	pnpm run typecheck

check: lint test typecheck

dev:
	pnpm run tauri dev

install-mac:
	pnpm run tauri build
	@APP_PATH=$$(ls -d src-tauri/target/release/bundle/macos/*.app 2>/dev/null | head -n 1); \
	if [ -z "$$APP_PATH" ]; then \
		echo "App bundle not found. Build may have failed."; \
		exit 1; \
	fi; \
	echo "Installing $$APP_PATH to /Applications..."; \
	rsync -a --delete "$$APP_PATH" /Applications/
