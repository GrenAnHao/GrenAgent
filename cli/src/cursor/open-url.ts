import * as childProcess from "node:child_process";

export interface OpenLoginUrlOptions {
	platform?: string;
	spawn?: (command: string[]) => void;
}

export function openLoginUrl(url: string, options: OpenLoginUrlOptions = {}): void {
	const platform = options.platform ?? process.platform;
	const command =
		platform === "win32"
			? ["rundll32", "url.dll,FileProtocolHandler", url]
			: platform === "darwin"
				? ["open", url]
				: ["xdg-open", url];
	const spawn = options.spawn ?? spawnLoginCommand;
	spawn(command);
}

function spawnLoginCommand(command: string[]): void {
	const [file, ...args] = command;
	if (!file) return;
	const child = childProcess.spawn(file, args, {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
	child.on("error", () => {});
}
