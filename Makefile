.PHONY: setup install lint test typecheck check dev

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
