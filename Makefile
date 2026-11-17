.PHONY: setup install lint test typecheck check dev install-mac release

setup: install

install:
	pnpm install

lint:
	pnpm run lint

test:
	pnpm run test
	cd src-tauri && cargo test

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

# Usage: make release VERSION=0.1.1
# Sets the version, commits, tags, and pushes. The tag starts the release
# workflow on GitHub, which builds the app and publishes a public release.
release: test typecheck
	@test -n "$(VERSION)" || { echo "Usage: make release VERSION=x.y.z"; exit 1; }
	@echo "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "VERSION must look like 1.2.3"; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD)" = "master" || { echo "Release from the master branch."; exit 1; }
	@test -z "$$(git status --porcelain --untracked-files=no)" || { echo "Commit your changes first."; exit 1; }
	@! git rev-parse -q --verify "refs/tags/v$(VERSION)" >/dev/null || { echo "Tag v$(VERSION) already exists."; exit 1; }
	perl -pi -e 's/^(\s*"version":\s*)"[^"]*"/$$1"$(VERSION)"/' package.json src-tauri/tauri.conf.json
	perl -0pi -e 's/(\[package\]\nname = "podload"\nversion = )"[^"]*"/$$1"$(VERSION)"/' src-tauri/Cargo.toml
	cd src-tauri && cargo metadata --format-version 1 > /dev/null
	git commit -am "Release $(VERSION)"
	git tag "v$(VERSION)"
	git push origin master "v$(VERSION)"
