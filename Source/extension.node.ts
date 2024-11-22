// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExtensionContext, ExtensionMode } from "vscode";

import { disposableStore } from "./common/lifecycle";
import { traceError } from "./common/logging";
import { SimpleFetch } from "./common/request";
import { JupyterRequestCreator } from "./common/requestCreator.node";
import { trackInstallOfExtension } from "./common/telemetry";
import { JupyterServerIntegration } from "./jupyterIntegration";
import { JupyterHubServerStorage } from "./storage";
import { ClassImplementationsForTests } from "./testUtils";
import { JupyterHubUrlCapture } from "./urlCapture";
import { getJupyterApi } from "./utils";

export async function activate(context: ExtensionContext) {
	trackInstallOfExtension();
	context.subscriptions.push(disposableStore);

	getJupyterApi()
		.then((api) => {
			const requestCreator = new JupyterRequestCreator();

			const fetch = new SimpleFetch(requestCreator);

			const storage = disposableStore.add(
				new JupyterHubServerStorage(
					context.secrets,
					context.globalState,
				),
			);

			const uriCapture = disposableStore.add(
				new JupyterHubUrlCapture(fetch, storage),
			);
			disposableStore.add(
				new JupyterServerIntegration(
					fetch,
					api.exports,
					storage,
					uriCapture,
				),
			);
		})
		.catch((ex) => traceError("Failed to activate jupyter extension", ex));

	if (context.extensionMode === ExtensionMode.Test) {
		return {
			RequestCreator: JupyterRequestCreator,
		} as ClassImplementationsForTests;
	}
}
