# Builds sbx for the host (macOS, with FSEvents) and for Linux remote boxes.
BIN := bin
SRC := $(shell find sbx -name '*.go' -o -name '*.sbpl') sbx/go.mod

all: $(BIN)/sbx-darwin-arm64 $(BIN)/sbx-linux-amd64 $(BIN)/sbx-linux-arm64

$(BIN)/sbx-darwin-arm64: $(SRC)
	cd sbx && GOOS=darwin GOARCH=arm64 CGO_ENABLED=1 go build -trimpath -ldflags='-s -w' -o ../$@ ./cmd/sbx

$(BIN)/sbx-linux-%: $(SRC)
	cd sbx && GOOS=linux GOARCH=$* CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o ../$@ ./cmd/sbx

test:
	cd sbx && go test ./...
	cd extension && npx tsc -p .

install: all
	./install.sh

.PHONY: all test install
