import * as _ from 'lodash';

import * as db from '../db';
import * as targetStateCache from '../device-state/target-state-cache';

import App from '../compose/app';
import * as images from '../compose/images';

import {
	InstancedAppState,
	TargetApp,
	TargetApps,
	TargetRelease,
	TargetService,
} from '../types/state';

type InstancedApp = InstancedAppState[0];

type DatabaseService = {
	appId: string;
	appUuid: string;
	releaseId: number;
	releaseUuid: string;
	serviceName: string;
	serviceId: number;
	imageId: number;
	image: string;

	// Service configurations
	[key: string]: any;
};

// Fetch and instance an app from the db. Throws if the requested appId cannot be found.
// Currently this function does quite a bit more than it needs to as it pulls in a bunch
// of required information for the instances but we should think about a method of not
// requiring that data here
export async function getApp(id: number): Promise<InstancedApp> {
	const dbApp = await getDBEntry(id);
	return await App.fromTargetState(dbApp);
}

export async function getApps(): Promise<InstancedAppState> {
	const dbApps = await getDBEntry();
	const apps: InstancedAppState = {};
	await Promise.all(
		dbApps.map(async (app) => {
			apps[app.appId] = await App.fromTargetState(app);
		}),
	);
	return apps;
}

export async function setApps(
	apps: TargetApps,
	source: string,
	trx?: db.Transaction,
) {
	const dbApps = Object.keys(apps).map((uuid) => {
		const { id: appId, ...app } = apps[uuid];

		// Get the first uuid
		const [commit] = Object.keys(app.releases);
		const release = commit ? app.releases[commit] : ({} as TargetRelease);

		const services = Object.keys(release.services ?? {}).map((serviceName) => {
			const { id: releaseId } = release;
			const { id: serviceId, image_id: imageId, ...service } = release.services[
				serviceName
			];

			return {
				...service,
				appId,
				appUuid: uuid,
				releaseId,
				commit,
				imageId,
				serviceId,
				serviceName,
				image: images.normalise(service.image),
			};
		});

		return {
			appId,
			uuid,
			source,
			name: app.name,
			...(commit && { releaseId: release.id, commit }),
			services: JSON.stringify(services),
			networks: JSON.stringify(release.networks ?? {}),
			volumes: JSON.stringify(release.volumes ?? {}),
		};
	});

	await targetStateCache.setTargetApps(dbApps, trx);
}

/**
 * Create target state from database state
 */
export async function getTargetJson(): Promise<TargetApps> {
	const dbApps = await getDBEntry();

	return dbApps
		.map(({ source, uuid, releaseId, commit, ...app }): [string, TargetApp] => {
			const services = (JSON.parse(app.services) as DatabaseService[])
				.map(({ serviceName, serviceId, imageId, ...service }): [
					string,
					TargetService,
				] => [
					serviceName,
					{
						id: serviceId,
						image_id: imageId,
						..._.omit(service, ['appId', 'appUuid', 'commit', 'releaseId']),
					} as TargetService,
				])
				// Map by serviceName
				.reduce(
					(svcs, [serviceName, s]) => ({
						...svcs,
						[serviceName]: s,
					}),
					{},
				);

			const releases = commit
				? {
						[commit]: {
							id: releaseId,
							services,
							networks: JSON.parse(app.networks),
							volumes: JSON.parse(app.volumes),
						} as TargetRelease,
				  }
				: {};

			return [
				// TODO: not totally sure about this
				uuid || String(app.appId),
				{
					id: app.appId,
					name: app.name,
					releases,
				},
			];
		})
		.reduce((apps, [uuid, app]) => ({ ...apps, [uuid]: app }), {});
}

function getDBEntry(): Promise<targetStateCache.DatabaseApp[]>;
function getDBEntry(appId: number): Promise<targetStateCache.DatabaseApp>;
async function getDBEntry(appId?: number) {
	await targetStateCache.initialized;

	return appId != null
		? targetStateCache.getTargetApp(appId)
		: targetStateCache.getTargetApps();
}
