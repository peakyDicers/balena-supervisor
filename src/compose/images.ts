import * as Bluebird from 'bluebird';
import * as Docker from 'dockerode';
import { EventEmitter } from 'events';
import * as _ from 'lodash';
import StrictEventEmitter from 'strict-event-emitter-types';

import * as config from '../config';
import * as db from '../db';
import * as constants from '../lib/constants';
import { DeltaFetchOptions, FetchOptions, docker } from '../lib/docker-utils';
import * as dockerUtils from '../lib/docker-utils';
import {
	DeltaStillProcessingError,
	NotFoundError,
	StatusError,
} from '../lib/errors';
import * as LogTypes from '../lib/log-types';
import * as logger from '../logger';
import { ImageDownloadBackoffError } from './errors';

import type { Service } from './service';
import { strict as assert } from 'assert';

import log from '../lib/supervisor-console';

interface FetchProgressEvent {
	percentage: number;
}

export interface Image {
	id?: number;
	/**
	 * image [registry/]repo@digest or [registry/]repo:tag
	 */
	name: string;
	/**
	 * @deprecated to be removed in target state v4
	 */
	appId: number;
	/**
	 * @deprecated to be removed in target state v4
	 */
	serviceId: number;
	serviceName: string;
	/**
	 * @deprecated to be removed in target state v4
	 */
	// Id from balena api
	imageId: number;
	releaseId: number;
	dependent: number;
	dockerImageId?: string;
	status?: 'Downloading' | 'Downloaded' | 'Deleting';
	downloadProgress?: number | null;
}

// Setup an event emitter
interface ImageEvents {
	change: void;
}
class ImageEventEmitter extends (EventEmitter as new () => StrictEventEmitter<
	EventEmitter,
	ImageEvents
>) {}
const events = new ImageEventEmitter();

export const on: typeof events['on'] = events.on.bind(events);
export const once: typeof events['once'] = events.once.bind(events);
export const removeListener: typeof events['removeListener'] = events.removeListener.bind(
	events,
);
export const removeAllListeners: typeof events['removeAllListeners'] = events.removeAllListeners.bind(
	events,
);

const imageFetchFailures: Dictionary<number> = {};
const imageFetchLastFailureTime: Dictionary<ReturnType<
	typeof process.hrtime
>> = {};
const imageCleanupFailures: Dictionary<number> = {};

type ImageState = Pick<Image, 'status' | 'downloadProgress'>;
type ImageTask = {
	// Indicates whether the task has been finished
	done?: boolean;

	// Current image state of the task
	context: Image;

	// Update the task with new context. This is a pure function
	// meaning it doesn't modify the original task
	update: (change?: ImageState) => ImageTaskUpdate;

	// Finish the task. This is a pure function
	// meaning it doesn't modify the original task
	finish: () => ImageTaskUpdate;
};

type ImageTaskUpdate = [ImageTask, boolean];

// Create new running task with the given initial context
function createTask(initialContext: Image) {
	// Task has only two state, is either running or finished
	const running = (context: Image): ImageTask => {
		return {
			context,
			update: ({ status, downloadProgress }: ImageState) =>
				// Keep current state
				[
					running({
						...context,
						...(status && { status }),
						...(downloadProgress && { downloadProgress }),
					}),
					// Only mark the task as changed if there is new data
					[status, downloadProgress].some((v) => !!v),
				],
			finish: () => [finished(context), true],
		};
	};

	// Once the task is finished, it cannot go back to a running state
	const finished = (context: Image): ImageTask => {
		return {
			done: true,
			context,
			update: () => [finished(context), false],
			finish: () => [finished(context), false],
		};
	};

	return running(initialContext);
}

const runningTasks: { [imageName: string]: ImageTask } = {};
function reportEvent(event: 'start' | 'update' | 'finish', state: Image) {
	const { name: imageName } = state;

	// Emit by default if a start event is reported
	let emitChange = event === 'start';

	// Get the current task and update it in memory
	const currentTask =
		event === 'start' ? createTask(state) : runningTasks[imageName];
	runningTasks[imageName] = currentTask;

	// TODO: should we assert that the current task exists at this point?
	// On update, update the corresponding task with the new state if it exists
	if (event === 'update' && currentTask) {
		const [updatedTask, changed] = currentTask.update(state);
		runningTasks[imageName] = updatedTask;
		emitChange = changed;
	}

	// On update, update the corresponding task with the new state if it exists
	if (event === 'finish' && currentTask) {
		[, emitChange] = currentTask.finish();
		delete runningTasks[imageName];
	}

	if (emitChange) {
		events.emit('change');
	}
}

type ServiceInfo = Pick<
	Service,
	'imageName' | 'appId' | 'serviceId' | 'serviceName' | 'imageId' | 'releaseId'
>;
export function imageFromService(service: ServiceInfo): Image {
	// We know these fields are defined because we create these images from target state
	return {
		name: service.imageName!,
		appId: service.appId,
		serviceId: service.serviceId!,
		serviceName: service.serviceName!,
		imageId: service.imageId!,
		releaseId: service.releaseId!,
		dependent: 0,
	};
}

export async function triggerFetch(
	image: Image,
	opts: FetchOptions,
	onFinish = _.noop,
	serviceName: string,
): Promise<void> {
	const appUpdatePollInterval = await config.get('appUpdatePollInterval');

	if (imageFetchFailures[image.name] != null) {
		// If we are retrying a pull within the backoff time of the last failure,
		// we need to throw an error, which will be caught in the device-state
		// engine, and ensure that we wait a bit lnger
		const minDelay = Math.min(
			2 ** imageFetchFailures[image.name] * constants.backoffIncrement,
			appUpdatePollInterval,
		);
		const timeSinceLastError = process.hrtime(
			imageFetchLastFailureTime[image.name],
		);
		const timeSinceLastErrorMs =
			timeSinceLastError[0] * 1000 + timeSinceLastError[1] / 1e6;
		if (timeSinceLastErrorMs < minDelay) {
			throw new ImageDownloadBackoffError();
		}
	}

	const onProgress = (progress: FetchProgressEvent) => {
		reportEvent('update', { ...image, downloadProgress: progress.percentage });
	};

	let success: boolean;
	try {
		const imageName = normalise(image.name);
		image = _.clone(image);
		image.name = imageName;

		// Look for a matching image on the engine
		const img = await inspectByName(image.name);

		// If we are at this point, the image may not have the proper tag so add it
		await tagImage(img.Id, image.name);

		// Create image on the database if it already exists on the engine
		await markAsSupervised({ ...image, dockerImageId: img.Id });

		onFinish(true);
		return;
	} catch (e) {
		if (!NotFoundError(e)) {
			if (!(e instanceof ImageDownloadBackoffError)) {
				addImageFailure(image.name);
			}
			throw e;
		}

		// Report a fetch start
		reportEvent('start', {
			...image,
			status: 'Downloading',
			downloadProgress: 0,
		});

		try {
			let id;
			if (opts.delta && (opts as DeltaFetchOptions).deltaSource != null) {
				id = await fetchDelta(image, opts, onProgress, serviceName);
			} else {
				id = await fetchImage(image, opts, onProgress);
			}

			// Tag the image with the proper reference
			await tagImage(id, image.name);

			// Create image on the database
			await markAsSupervised({ ...image, dockerImageId: id });

			logger.logSystemEvent(LogTypes.downloadImageSuccess, { image });
			success = true;
			delete imageFetchFailures[image.name];
			delete imageFetchLastFailureTime[image.name];
		} catch (err) {
			if (err instanceof DeltaStillProcessingError) {
				// If this is a delta image pull, and the delta still hasn't finished generating,
				// don't show a failure message, and instead just inform the user that it's remotely
				// processing
				logger.logSystemEvent(LogTypes.deltaStillProcessingError, {});
			} else {
				addImageFailure(image.name);
				logger.logSystemEvent(LogTypes.downloadImageError, {
					image,
					error: err,
				});
			}
			success = false;
		}
	}

	reportEvent('finish', image);
	onFinish(success);
}

export async function remove(image: Image): Promise<void> {
	try {
		await removeImageIfNotNeeded(image);
	} catch (e) {
		logger.logSystemEvent(LogTypes.deleteImageError, {
			image,
			error: e,
		});
		throw e;
	}
}

export function getByDockerId(id: string): Promise<Image> {
	return db.models('image').where({ dockerImageId: id }).first();
}

export async function removeByDockerId(id: string): Promise<void> {
	const image = await getByDockerId(id);
	await remove(image);
}

export function getNormalisedTags(image: Docker.ImageInfo): string[] {
	return (image.RepoTags || []).map(normalise);
}

async function withImagesFromDockerAndDB<T>(
	cb: (dockerImages: Docker.ImageInfo[], composeImages: Image[]) => T,
) {
	const [normalisedImages, dbImages] = await Promise.all([
		Bluebird.map(docker.listImages({ digests: true }), (image) => ({
			...image,
			RepoTag: getNormalisedTags(image),
		})),
		db.models('image').select(),
	]);
	return cb(normalisedImages, dbImages);
}

function addImageFailure(imageName: string, time = process.hrtime()) {
	imageFetchLastFailureTime[imageName] = time;
	imageFetchFailures[imageName] =
		imageFetchFailures[imageName] != null
			? imageFetchFailures[imageName] + 1
			: 1;
}

function matchesTagOrDigest(
	image: Image,
	dockerImage: Docker.ImageInfo,
): boolean {
	return (
		_.includes(dockerImage.RepoTags, dockerUtils.getImageWithTag(image.name)) ||
		_.some(dockerImage.RepoDigests, (digest) =>
			hasSameDigest(image.name, digest),
		)
	);
}

function isAvailableInDocker(
	image: Image,
	dockerImages: Docker.ImageInfo[],
): boolean {
	return _.some(
		dockerImages,
		(dockerImage) =>
			matchesTagOrDigest(image, dockerImage) ||
			image.dockerImageId === dockerImage.Id,
	);
}

export async function getAvailable(): Promise<Image[]> {
	return withImagesFromDockerAndDB((dockerImages, supervisedImages) =>
		_.filter(supervisedImages, (image) =>
			isAvailableInDocker(image, dockerImages),
		),
	);
}

export function getDownloadingImageIds(): number[] {
	return Object.values(runningTasks)
		.filter((t) => t.context.status === 'Downloading')
		.map((t) => t.context.imageId);
}

export function getDownloadingImageNames(): string[] {
	return Object.values(runningTasks)
		.filter((t) => t.context.status === 'Downloading')
		.map((t) => t.context.name);
}

export async function cleanImageData(): Promise<void> {
	const imagesToRemove = await withImagesFromDockerAndDB(
		async (dockerImages, supervisedImages) => {
			for (const supervisedImage of supervisedImages) {
				// If the supervisor was interrupted between fetching an image and storing its id,
				// some entries in the db might need to have the dockerImageId populated
				if (supervisedImage.dockerImageId == null) {
					const id = _.get(
						_.find(dockerImages, (dockerImage) =>
							matchesTagOrDigest(supervisedImage, dockerImage),
						),
						'Id',
					);

					if (id != null) {
						await db
							.models('image')
							.update({ dockerImageId: id })
							.where(supervisedImage);
						supervisedImage.dockerImageId = id;
					}
				}
			}

			// If the supervisor was interrupted between fetching the image and adding
			// the tag, the engine image may have been left without the proper tag leading
			// to issues with removal. Add tag just in case
			await Promise.all(
				supervisedImages
					.filter((image) => isAvailableInDocker(image, dockerImages))
					.map((image) => tagImage(image.dockerImageId!, image.name)),
			).catch(() => []); // Ignore errors

			// If the image is in the DB but not available in docker, return it
			// for removal on the database
			return _.reject(supervisedImages, (image) =>
				isAvailableInDocker(image, dockerImages),
			);
		},
	);

	const ids = _(imagesToRemove).map('id').compact().value();
	await db.models('image').del().whereIn('id', ids);
}

/**
 * This and other current state methods will be replaced by ApplicationManager.getState, at which
 * point the only place this will be used will be in the API endpoints
 * once, the API moves to v3 or we update the endpoints to return uuids, we will
 *  be able to get rid of this
 *  @deprecated
 */
export const getLegacyState = async () => {
	const images = (await getAvailable()).map((img) => ({
		...img,
		status: 'Downloaded' as Image['status'],
		downloadImageSuccess: null,
	}));

	const imagesFromRunningTasks = Object.values(runningTasks).map(
		(task) => task.context,
	);
	const runningImageIds = imagesFromRunningTasks.map((img) => img.imageId);

	// TODO: this is possibly wrong, the value from getAvailable should be more reliable
	// than the value from running tasks
	return imagesFromRunningTasks.concat(
		images.filter((img) => !runningImageIds.includes(img.imageId)),
	);
};

export async function update(image: Image): Promise<void> {
	const formattedImage = format(image);
	await db
		.models('image')
		.update(formattedImage)
		.where({ name: formattedImage.name });
}

const tagImage = async (dockerImageId: string, imageName: string) => {
	const { repo, tag } = dockerUtils.getRepoAndTag(imageName);
	return await docker.getImage(dockerImageId).tag({ repo, tag });
};

export const save = async (image: Image): Promise<void> => {
	const img = await inspectByName(image.name);

	// Ensure image is tagged
	await tagImage(img.Id, image.name);

	image = _.clone(image);
	image.dockerImageId = img.Id;
	await markAsSupervised(image);
};

async function getImagesForCleanup(): Promise<string[]> {
	const images: string[] = [];

	const supervisorImageInfo = dockerUtils.getRegistryAndName(
		constants.supervisorImage,
	);
	const [supervisorImage, usedImageIds] = await Promise.all([
		docker.getImage(constants.supervisorImage).inspect(),
		db
			.models('image')
			.select('dockerImageId')
			.then((vals) => vals.map((img: Image) => img.dockerImageId)),
	]);

	// TODO: remove after we agree on what to do for
	// supervisor image cleanup after hup
	const supervisorRepos = [supervisorImageInfo.imageName];
	// If we're on the new balena/ARCH-supervisor image
	if (_.startsWith(supervisorImageInfo.imageName, 'balena/')) {
		supervisorRepos.push(
			supervisorImageInfo.imageName.replace(/^balena/, 'resin'),
		);
	}

	// TODO: same as above, we no longer use tags to identify supervisors
	const isSupervisorRepoTag = ({
		imageName,
		tagName,
	}: {
		imageName: string;
		tagName?: string;
	}) => {
		return (
			_.some(supervisorRepos, (repo) => imageName === repo) &&
			tagName !== supervisorImageInfo.tagName
		);
	};

	const dockerImages = await docker.listImages({ digests: true });
	for (const image of dockerImages) {
		// Cleanup should remove truly dangling images (i.e dangling and with no digests)
		if (isDangling(image) && !_.includes(usedImageIds, image.Id)) {
			images.push(image.Id);
		} else if (!_.isEmpty(image.RepoTags) && image.Id !== supervisorImage.Id) {
			// We also remove images from the supervisor repository with a different tag
			for (const tag of image.RepoTags) {
				const imageNameComponents = dockerUtils.getRegistryAndName(tag);
				// If
				if (isSupervisorRepoTag(imageNameComponents)) {
					images.push(image.Id);
				}
			}
		}
	}

	return _(images)
		.uniq()
		.filter(
			(image) =>
				imageCleanupFailures[image] == null ||
				Date.now() - imageCleanupFailures[image] >
					constants.imageCleanupErrorIgnoreTimeout,
		)
		.value();
}

// Look for an image in the engine with registry/image as reference (tag)
// for images with deltas this should return unless there is some inconsistency
// and the tag was deleted.
const inspectByReference = async (imageName: string) => {
	const { registry, imageName: name, tagName } = dockerUtils.getRegistryAndName(
		imageName,
	);

	const repo = [registry, name].filter((s) => !!s).join('/');
	const reference = [repo, tagName].filter((s) => !!s).join(':');

	return await docker
		.listImages({
			digests: true,
			filters: { reference: [reference] },
		})
		.then(([img]) =>
			!!img
				? docker.getImage(img.Id).inspect()
				: Promise.reject(
						new StatusError(
							404,
							`Failed to find an image matching ${imageName}`,
						),
				  ),
		);
};

// Get image by the full image URI. This will only work for regular pulls
// and old style images `repo:tag`.
const inspectByURI = async (imageName: string) =>
	await docker.getImage(imageName).inspect();

// Look in the database for an image with same digest or same name and
// get the dockerImageId from there. If this fails the image may still be on the
// engine but we need to re-trigger fetch and let the engine tell us if the
// image data is there.
const inspectByDigest = async (imageName: string) => {
	const { digest } = dockerUtils.getRegistryAndName(imageName);
	return await db
		.models('image')
		.where('name', 'like', `%${digest}`)
		.orWhere({ name: imageName }) // Default to looking for the full image name
		.select()
		.then((images) => images.filter((img: Image) => img.dockerImageId !== null))
		// Assume that all db entries will point to the same dockerImageId, so use
		// the first one. If this assumption is false, there is a bug with cleanup
		.then(([img]) =>
			!!img
				? docker.getImage(img.dockerImageId).inspect()
				: Promise.reject(
						new StatusError(
							404,
							`Failed to find an image matching ${imageName}`,
						),
				  ),
		);
};

export async function inspectByName(imageName: string) {
	// Fail fast if image name is null or empty string
	assert(!!imageName, `image name to inspect is invalid, got: ${imageName}`);

	// Run the queries in sequence, return the first one that matches or
	// the error from the last query
	return await [inspectByURI, inspectByReference, inspectByDigest].reduce(
		(promise, query) => promise.catch(() => query(imageName)),
		Promise.reject(
			'Promise sequence in inspectByName is broken. This is a bug.',
		),
	);
}

export async function isCleanupNeeded() {
	return !_.isEmpty(await getImagesForCleanup());
}

export async function cleanup() {
	const images = await getImagesForCleanup();
	for (const image of images) {
		log.debug(`Cleaning up ${image}`);
		try {
			await docker.getImage(image).remove({ force: true });
			delete imageCleanupFailures[image];
		} catch (e) {
			logger.logSystemMessage(
				`Error cleaning up ${image}: ${e.message} - will ignore for 1 hour`,
				{ error: e },
				'Image cleanup error',
			);
			imageCleanupFailures[image] = Date.now();
		}
	}
}

export function isSameImage(
	image1: Pick<Image, 'name'>,
	image2: Pick<Image, 'name'>,
): boolean {
	return (
		image1?.name === image2?.name || hasSameDigest(image1?.name, image2?.name)
	);
}

export function normalise(imageName: string) {
	return dockerUtils.normaliseImageName(imageName);
}

function isDangling(image: Docker.ImageInfo): boolean {
	return (
		(_.isEmpty(image.RepoTags) ||
			_.isEqual(image.RepoTags, ['<none>:<none>'])) &&
		(_.isEmpty(image.RepoDigests) ||
			_.isEqual(image.RepoDigests, ['<none>@<none>']))
	);
}

function hasSameDigest(
	name1: Nullable<string>,
	name2: Nullable<string>,
): boolean {
	const hash1 = name1 != null ? name1.split('@')[1] : null;
	const hash2 = name2 != null ? name2.split('@')[1] : null;
	return hash1 != null && hash1 === hash2;
}

async function removeImageIfNotNeeded(image: Image): Promise<void> {
	let removed: boolean;

	// We first fetch the image from the DB to ensure it exists,
	// and get the dockerImageId and any other missing fields
	const images = await db.models('image').select().where(image);

	if (images.length === 0) {
		removed = false;
	}

	const img = images[0];
	try {
		const { registry, imageName, tagName } = dockerUtils.getRegistryAndName(
			img.name,
		);
		// Look for an image in the engine with registry/image as reference (tag)
		// for images with deltas this should return unless there is some inconsistency
		// and the tag was deleted
		const repo = [registry, imageName].filter((s) => !!s).join('/');
		const reference = [repo, tagName].filter((s) => !!s).join(':');

		const tags = (
			await docker.listImages({
				digests: true,
				filters: { reference: [reference] },
			})
		).reduce(
			(tagList, imgInfo) => tagList.concat(imgInfo.RepoTags || []),
			[] as string[],
		);

		reportEvent('start', { ...image, status: 'Deleting' });
		logger.logSystemEvent(LogTypes.deleteImage, { image });

		// The engine doesn't handle concurrency too well. If two requests to
		// remove the last image tag are sent to the engine at the same time
		// (e.g. for two services built from the same image).
		// that can lead to weird behavior with the error
		// `(HTTP code 500) server error - unrecognized image ID`.
		// This random delay tries to prevent that
		await new Promise((resolve) => setTimeout(resolve, Math.random() * 100));

		// Remove all matching tags in sequence
		// as removing in parallel causes some engine weirdness (see above)
		// this stops on the first error
		await tags.reduce(
			(promise, tag) => promise.then(() => docker.getImage(tag).remove()),
			Promise.resolve(),
		);

		// Check for any remaining digests.
		const digests = (
			await docker.listImages({
				digests: true,
				filters: { reference: [reference] },
			})
		).reduce(
			(digestList, imgInfo) => digestList.concat(imgInfo.RepoDigests || []),
			[] as string[],
		);

		// Remove all remaining digests
		await digests.reduce(
			(promise, digest) => promise.then(() => docker.getImage(digest).remove()),
			Promise.resolve(),
		);

		// Mark the image as removed
		removed = true;
	} catch (e) {
		if (NotFoundError(e)) {
			removed = false;
		} else {
			throw e;
		}
	} finally {
		reportEvent('finish', image);
	}

	await db.models('image').del().where({ id: img.id });

	if (removed) {
		logger.logSystemEvent(LogTypes.deleteImageSuccess, { image });
	}
}

async function markAsSupervised(image: Image): Promise<void> {
	const formattedImage = format(image);
	await db.upsertModel(
		'image',
		formattedImage,
		// TODO: Upsert to new values only when they already match? This is likely a bug
		// and currently acts like an "insert if not exists"
		formattedImage,
	);
}

function format(image: Image): Partial<Omit<Image, 'id'>> {
	return _(image)
		.defaults({
			serviceId: null,
			serviceName: null,
			imageId: null,
			releaseId: null,
			dependent: 0,
			dockerImageId: null,
		})
		.omit('id')
		.value();
}

async function fetchDelta(
	image: Image,
	opts: FetchOptions,
	onProgress: (evt: FetchProgressEvent) => void,
	serviceName: string,
): Promise<string> {
	logger.logSystemEvent(LogTypes.downloadImageDelta, { image });

	const deltaOpts = (opts as unknown) as DeltaFetchOptions;
	const srcImage = await inspectByName(deltaOpts.deltaSource);

	deltaOpts.deltaSourceId = srcImage.Id;
	const id = await dockerUtils.fetchDeltaWithProgress(
		image.name,
		deltaOpts,
		onProgress,
		serviceName,
	);

	return id;
}

function fetchImage(
	image: Image,
	opts: FetchOptions,
	onProgress: (evt: FetchProgressEvent) => void,
): Promise<string> {
	logger.logSystemEvent(LogTypes.downloadImage, { image });
	return dockerUtils.fetchImageWithProgress(image.name, opts, onProgress);
}
