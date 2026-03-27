.PHONY: build serve start

build:
	npm install
	npm run build

serve:
	python3 -m http.server 8765 --bind 127.0.0.1

start: build serve
