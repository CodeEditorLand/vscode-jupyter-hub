// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { JupyterServer } from "@vscode/jupyter-extension";
import {
	CancellationError,
	CancellationToken,
	env,
	l10n,
	QuickInputButton,
	ThemeIcon,
	Uri,
	type QuickPickItem,
} from "vscode";

import { Authenticator } from "./authenticator";
import { WorkflowInputCapture } from "./common/inputCapture";
import { DisposableStore, dispose } from "./common/lifecycle";
import { Localized } from "./common/localize";
import { traceDebug, traceError, traceWarn } from "./common/logging";
import { SimpleFetch } from "./common/request";
import {
	sendJupyterHubUrlAdded,
	sendJupyterHubUrlNotAdded,
} from "./common/telemetry";
import { noop, uuid } from "./common/utils";
import {
	extractTokenFromUrl,
	extractUserNameFromUrl,
	getJupyterHubBaseUrl,
	getVersion,
	listServers,
	type ApiTypes,
} from "./jupyterHubApi";
import { JupyterHubServerStorage } from "./storage";
import { IAuthenticator } from "./types";
import { isWebExtension } from "./utils";
import {
	isSelfCertsError,
	isSelfCertsExpiredError,
	JupyterHubConnectionValidator,
} from "./validator";

export class JupyterHubUrlCapture {
	private readonly jupyterConnection: JupyterHubConnectionValidator;

	private readonly displayNamesOfHandles = new Map<string, string>();

	private readonly newAuthenticator: Authenticator;

	private readonly disposable = new DisposableStore();

	constructor(
		private readonly fetch: SimpleFetch,
		private readonly storage: JupyterHubServerStorage,
	) {
		this.newAuthenticator = new Authenticator(fetch);

		this.jupyterConnection = new JupyterHubConnectionValidator(fetch);
	}

	dispose() {
		this.disposable.dispose();
	}

	public async captureRemoteJupyterUrl(
		token: CancellationToken,
		initialUrl: string = "",
		displayName: string = "",
		validationErrorMessage: string = "",
		serverId = uuid(),
		reasonForCapture:
			| "cameHereFromBackButton"
			| "captureNewUrl" = "captureNewUrl",
	): Promise<JupyterServer | undefined> {
		try {
			return await this.captureRemoteJupyterUrlImpl(
				initialUrl,
				displayName,
				validationErrorMessage,
				serverId,
				reasonForCapture,
				token,
			);
		} catch (ex) {
			if (!(ex instanceof CancellationError)) {
				traceError("Failed to capture remote jupyter server", ex);
			}

			throw ex;
		}
	}

	private async captureRemoteJupyterUrlImpl(
		url: string = "",
		displayName: string = "",
		validationErrorMessage: string = "",
		id = uuid(),
		reasonForCapture:
			| "cameHereFromBackButton"
			| "captureNewUrl" = "captureNewUrl",
		token: CancellationToken,
	): Promise<JupyterServer | undefined> {
		const state: State = {
			auth: { username: "", password: "", token: "", tokenId: "" },
			baseUrl: "",
			serverName: undefined,
			hubVersion: "",
			urlWasPrePopulated: false,
			url,
			displayName,
			displayNamesOfHandles: this.displayNamesOfHandles,
			errorMessage: validationErrorMessage,
			serverId: id,
		};

		const steps: MultiStep<Step, State>[] = [
			new GetUrlStep(this.fetch),
			new GetUserName(),
			new GetPassword(this.newAuthenticator),
			new VerifyConnection(this.jupyterConnection, this.newAuthenticator),
			new ServerSelector(this.fetch),
			new GetDisplayName(this.storage),
		];

		const disposables = new DisposableStore();

		let nextStep: Step | undefined = "Get Url";

		if (url) {
			// Validate the URI first, which would otherwise be validated when user enters the Uri into the input box.
			if (isValidUrl(url)) {
				try {
					state.baseUrl = await getJupyterHubBaseUrl(
						url,
						this.fetch,
						token,
					);

					const version = await getVersion(
						state.baseUrl,
						this.fetch,
						token,
					);

					state.hubVersion = version;

					state.urlWasPrePopulated = true;

					nextStep =
						reasonForCapture === "captureNewUrl"
							? "Get Username"
							: "Get Url";
				} catch {
					validationErrorMessage = Localized.invalidJupyterHubUrl;
				}
			} else {
				// Uri has an error, show the error message by displaying the input box and pre-populating the url.
				validationErrorMessage = Localized.jupyterSelectURIInvalidURI;

				nextStep = "Get Url";
			}
		}

		try {
			const stepsExecuted: Step[] = [];

			while (true) {
				const step = steps
					.filter((s) => !s.disabled)
					.find((s) => s.step === nextStep);

				if (!step) {
					traceError(`Step '${nextStep}' Not found`);

					throw new CancellationError();
				}

				nextStep = await step.run(state, token);

				if (nextStep === "Before") {
					sendJupyterHubUrlNotAdded("back", step.step);

					return;
				}

				if (nextStep === "After") {
					sendJupyterHubUrlAdded(state.baseUrl, state.hubVersion, id);

					await this.storage.addServerOrUpdate(
						{
							id,
							baseUrl: state.baseUrl,
							displayName: state.displayName,
							serverName: state.serverName,
						},
						{
							username: state.auth.username,
							password: state.auth.password,
							token: state.auth.token,
							tokenId: state.auth.tokenId,
						},
					);

					return {
						id,
						label: state.displayName,
					};
				}

				if (nextStep) {
					// If nextStep is something that we have already executed in the past
					// then this means we're actually going back to that step.
					// So, remove everything from the stack that we have executed in the past.
					if (stepsExecuted.includes(nextStep)) {
						stepsExecuted.splice(stepsExecuted.indexOf(nextStep));

						continue;
					}

					if (step.canNavigateBackToThis) {
						stepsExecuted.push(step.step);
					}

					continue;
				}

				if (stepsExecuted.length) {
					nextStep = stepsExecuted.pop();

					continue;
				}

				sendJupyterHubUrlNotAdded("cancel", step.step);

				return;
			}
		} catch (ex) {
			if (ex instanceof CancellationError) {
				sendJupyterHubUrlNotAdded("cancel", "");
			} else {
				traceError("Failed to capture remote jupyter server", ex);

				sendJupyterHubUrlNotAdded("error", "");
			}

			throw ex;
		} finally {
			dispose(disposables);
		}
	}
}
type Step =
	| "Before"
	| "Get Url"
	| "Get Username"
	| "Get Password"
	| "Verify Connection"
	| "Server Selector"
	| "Get Display Name"
	| "After";

interface MultiStep<T, State> {
	step: Step;
	/**
	 * Whether this step is disabled.
	 * Can get disabled as a result of calling `run`.
	 * Meaning, this step should be skipped in the future.
	 */
	disabled?: boolean;

	canNavigateBackToThis: boolean;

	dispose(): void;

	run(state: State, token: CancellationToken): Promise<T | undefined>;
}
type State = {
	displayNamesOfHandles: Map<string, string>;

	urlWasPrePopulated: boolean;

	serverId: string;
	/**
	 * Name of the server to start (named jupyter hub servers).
	 */
	serverName: string | undefined;

	errorMessage: string;

	url: string;

	displayName: string;

	baseUrl: string;

	hubVersion: string;

	auth: {
		username: string;

		password: string;

		token: string;

		tokenId: string;
	};
};

class GetUrlStep extends DisposableStore implements MultiStep<Step, State> {
	step: Step = "Get Url";

	canNavigateBackToThis = true;

	constructor(private readonly fetch: SimpleFetch) {
		super();
	}

	async run(state: State, token: CancellationToken) {
		if (!state.url) {
			try {
				// In web trying to read clipboard can be iffy, as users may get a prompt to allow that.
				// And that UX isn't great. So skip this for web.
				const text = isWebExtension()
					? ""
					: await env.clipboard.readText();

				const parsedUri = new URL(text.trim());
				// Only display http/https uris.
				state.url =
					text &&
					parsedUri &&
					parsedUri.protocol.toLowerCase().startsWith("http")
						? text
						: "";
			} catch {
				// We can ignore errors.
			}
		}

		const validationMessage = state.errorMessage;

		state.errorMessage = "";

		const url = await this.add(new WorkflowInputCapture()).getValue(
			{
				title: Localized.titleOfInputBoxToEnterUrl,
				placeholder: Localized.placeholderOfInputBoxToEnterUrl,
				value: state.url,
				validationMessage,
				validateInput: async (value) => {
					value = value.trim();

					if (!isValidUrl(value)) {
						return Localized.jupyterSelectURIInvalidURI;
					}

					try {
						await getJupyterHubBaseUrl(value, this.fetch, token);
					} catch (ex) {
						traceError(
							`Failed to determine base url for ${value}`,
							ex,
						);

						return Localized.invalidJupyterHubUrl;
					}
				},
			},
			token,
		);

		if (!url) {
			return;
		}

		state.url = url;

		state.baseUrl = await getJupyterHubBaseUrl(url, this.fetch, token);

		state.hubVersion = await getVersion(state.baseUrl, this.fetch, token);

		state.auth.username =
			state.auth.username || extractUserNameFromUrl(url) || "";

		state.auth.token = state.auth.token || extractTokenFromUrl(url) || "";

		return "Get Username";
	}
}
class GetUserName extends DisposableStore implements MultiStep<Step, State> {
	step: Step = "Get Username";

	canNavigateBackToThis = true;

	async run(state: State, token: CancellationToken) {
		const errorMessage = state.errorMessage;

		state.errorMessage = ""; // Never display this validation message again.
		const username = await this.add(new WorkflowInputCapture()).getValue(
			{
				title: Localized.captureUserNameTitle,
				value: state.auth.username || extractUserNameFromUrl(state.url),
				placeholder: Localized.captureUserNamePrompt,
				validationMessage: errorMessage,
				validateInput: async (value) =>
					value ? undefined : Localized.emptyUserNameErrorMessage,
			},
			token,
		);

		if (!username) {
			return;
		}

		state.auth.username = username;

		return "Get Password";
	}
}
class GetPassword extends DisposableStore implements MultiStep<Step, State> {
	step: Step = "Get Password";

	canNavigateBackToThis = true;

	constructor(private readonly authenticator: IAuthenticator) {
		super();
	}

	async run(
		state: State,
		token: CancellationToken,
	): Promise<Step | undefined> {
		// In vscode.dev or the like, username/password auth doesn't work
		// as JupyterHub doesn't support CORS. So we need to use API tokens.
		const input = this.add(new WorkflowInputCapture());

		const moreInfo: QuickInputButton = {
			iconPath: new ThemeIcon("info"),
			tooltip: Localized.authMethodApiTokenMoreInfoTooltip,
		};

		const password = await input.getValue(
			{
				title: Localized.capturePasswordTitle,
				placeholder: Localized.capturePasswordPrompt,
				value:
					state.auth.password ||
					state.auth.token ||
					extractTokenFromUrl(state.url) ||
					"",
				password: true,
				buttons: [moreInfo],
				onDidTriggerButton: (e) => {
					if (e === moreInfo) {
						env.openExternal(
							Uri.parse(
								"https://aka.ms/vscodeJupyterHubApiToken",
							),
						).then(noop, noop);
					}
				},
				validateInput: async (value) => {
					if (!value) {
						return Localized.emptyPasswordErrorMessage;
					}

					try {
						state.auth.password = value;

						const result =
							await this.authenticator.getJupyterAuthInfo(
								{
									baseUrl: state.baseUrl,
									authInfo: state.auth,
								},
								token,
							);

						state.auth.token = result.token || "";

						state.auth.tokenId = result.tokenId || "";

						traceDebug(
							`Got an Auth token = ${state.auth.token.length} && ${
								state.auth.token.trim().length
							}, tokenId = ${state.auth.tokenId.length} && ${state.auth.tokenId.trim().length} for ${
								state.baseUrl
							}`,
						);
					} catch (err) {
						traceError("Failed to get Auth Info", err);

						if (err instanceof CancellationError) {
							throw err;
						} else if (isSelfCertsError(err)) {
							// We can skip this for now, as this will get verified again
							// First we need to check with user whether to allow insecure connections and untrusted certs.
						} else if (isSelfCertsExpiredError(err)) {
							// We can skip this for now, as this will get verified again
							// First we need to check with user whether to allow insecure connections and untrusted certs.
						} else {
							traceError(
								`Failed to validate username and password for ${state.baseUrl}`,
								err,
							);

							return Localized.usernamePasswordAuthFailure;
						}
					}
				},
			},
			token,
		);

		if (!password) {
			return;
		}

		state.auth.password = password;

		return "Verify Connection";
	}
}

class VerifyConnection
	extends DisposableStore
	implements MultiStep<Step, State>
{
	step: Step = "Verify Connection";

	canNavigateBackToThis = false;

	constructor(
		private readonly jupyterConnection: JupyterHubConnectionValidator,
		private readonly authenticator: IAuthenticator,
	) {
		super();
	}

	async run(
		state: State,
		token: CancellationToken,
	): Promise<Step | undefined> {
		try {
			await this.jupyterConnection.validateJupyterUri(
				state.baseUrl,
				state.auth,
				this.authenticator,
				token,
			);
		} catch (err) {
			traceError("Uri verification error", err);

			if (err instanceof CancellationError) {
				throw err;
			} else if (isSelfCertsError(err)) {
				state.errorMessage =
					Localized.jupyterSelfCertFailErrorMessageOnly;

				return "Get Url";
			} else if (isSelfCertsExpiredError(err)) {
				state.errorMessage =
					Localized.jupyterSelfCertExpiredErrorMessageOnly;

				return "Get Url";
			} else {
				state.errorMessage = Localized.usernamePasswordAuthFailure;

				return "Get Username";
			}
		}

		return "Server Selector";
	}
}

function getServerStatus(server: ApiTypes.ServerInfo) {
	switch (server.pending) {
		case "spawn":
			return l10n.t("Starting");

		case "stop":
			return l10n.t("Shutting down");

		default:
			return server.ready ? l10n.t("Running") : l10n.t("Stopped");
	}
}
class ServerSelector extends DisposableStore implements MultiStep<Step, State> {
	step: Step = "Server Selector";

	disabled?: boolean | undefined;

	canNavigateBackToThis = false;

	constructor(private readonly fetch: SimpleFetch) {
		super();
	}

	async run(
		state: State,
		token: CancellationToken,
	): Promise<Step | undefined> {
		try {
			const servers = await listServers(
				state.baseUrl,
				state.auth.username,
				state.auth.token,
				this.fetch,
				token,
			);

			if (
				servers.length === 0 ||
				(servers.length === 1 && !servers[0].name)
			) {
				traceDebug("No servers found for the user");

				this.disabled = true;

				return "Get Display Name";
			}

			interface ServerQuickPick extends QuickPickItem {
				server: ApiTypes.ServerInfo;
			}

			const quickPickItems: ServerQuickPick[] = servers.map((server) => ({
				label: server.name || "Default Server",
				description: `(${getServerStatus(server)})`,
				server,
			}));

			const selection = await new WorkflowInputCapture().pickValue(
				{
					title: l10n.t("Select a Server"),
					quickPickItems,
				},
				token,
			);

			if (!selection) {
				return;
			}

			state.serverName = selection.server.name;
		} catch (err) {
			if (err instanceof CancellationError) {
				throw err;
			}

			this.disabled = true;

			traceWarn(
				"Failed to list all of the servers for the user, assuming there aren't any",
				err,
			);
		}

		return "Get Display Name";
	}
}
class GetDisplayName extends DisposableStore implements MultiStep<Step, State> {
	step: Step = "Get Display Name";

	canNavigateBackToThis = false;

	constructor(private readonly storage: JupyterHubServerStorage) {
		super();
	}

	async run(
		state: State,
		token: CancellationToken,
	): Promise<Step | undefined> {
		const suggestedDisplayName = getSuggestedDisplayName(
			state.url,
			state.serverName,
			this.storage.all.map((s) => s.displayName),
		);

		const displayName = await this.add(new WorkflowInputCapture()).getValue(
			{
				title: Localized.jupyterRenameServer,
				value: state.displayName || suggestedDisplayName,
			},
			token,
		);

		if (!displayName) {
			return;
		}

		state.displayName = displayName;

		return "After";
	}
}

export function getSuggestedDisplayName(
	baseUrl: string,
	serverName: string | undefined,
	usedNames: string[],
) {
	const usedNamesSet = new Set(usedNames.map((s) => s.toLowerCase()));

	usedNamesSet.add("localhost");

	usedNamesSet.add("");

	const isIPAddress =
		typeof parseInt(new URL(baseUrl).hostname.charAt(0), 10) === "number";

	let hostName = isIPAddress ? "JupyterHub" : new URL(baseUrl).hostname;

	hostName = serverName ? `${hostName} (${serverName})` : hostName;

	if (!isIPAddress && !usedNamesSet.has(hostName.toLowerCase())) {
		return hostName;
	}

	for (let i = 0; i < 10; i++) {
		const name = i === 0 ? hostName : `${hostName} ${i}`;

		if (!usedNamesSet.has(name.toLowerCase())) {
			return name;
		}
	}

	return "JupyterHub";
}

function isValidUrl(value: string) {
	try {
		new URL(value);

		return true;
	} catch (err) {
		traceDebug(`Failed to parse URI`, err);

		return false;
	}
}
