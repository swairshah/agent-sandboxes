# The default moonlet orb: a Linux user with sudo, common developer tools, and a desktop (a virtual display, a
# window manager, a VNC server with noVNC, and Google Chrome) that the agent starts on demand. The bootstrap installs
# itself from the control plane at spawn, so only bash, curl and coreutils are needed for that.
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash build-essential ca-certificates curl ffmpeg file git gnupg imagemagick jq less openssh-client procps \
		python3 python3-pip python3-venv ripgrep sudo tmux unzip vim-tiny wget xz-utils \
		xvfb x11vnc novnc websockify fluxbox xterm fonts-liberation fonts-noto-color-emoji dbus-x11 \
	&& curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
	&& apt-get install -y --no-install-recommends /tmp/chrome.deb \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" >/etc/apt/sources.list.d/github-cli.list \
	&& apt-get update && apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/* /tmp/chrome.deb
# Node.js LTS with npm and pnpm, Bun and uv, system-wide.
RUN curl -fsSL https://nodejs.org/dist/v22.21.0/node-v22.21.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1 \
	&& npm install -g pnpm@10 \
	&& curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash \
	&& curl -fsSL https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
RUN useradd -m -s /bin/bash orb && echo 'orb ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/orb
USER orb
WORKDIR /home/orb
CMD ["sleep", "infinity"]
