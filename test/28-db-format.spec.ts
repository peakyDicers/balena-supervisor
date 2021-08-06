import { expect } from 'chai';
import { isRight } from 'fp-ts/lib/Either';
import * as sinon from 'sinon';
import App from '../src/compose/app';
import Network from '../src/compose/network';
import * as config from '../src/config';
import * as dbFormat from '../src/device-state/db-format';
import log from '../src/lib/supervisor-console';
import { TargetApps } from '../src/types/state';
import * as dbHelper from './lib/db-helper';
import { withMockerode } from './lib/mockerode';

function getDefaultNetwork(appId: number) {
	return {
		default: Network.fromComposeObject('default', appId, {}),
	};
}

describe('db-format', () => {
	let testDb: dbHelper.TestDatabase;
	let apiEndpoint: string;
	before(async () => {
		testDb = await dbHelper.createDB();

		await config.initialized;
		// Prevent side effects from changes in config
		sinon.stub(config, 'on');

		// TargetStateCache checks the API endpoint to
		// store and invalidate the cache
		// TODO: this is an implementation detail that
		// should not be part of the test suite. We need to change
		// the target state architecture for this
		apiEndpoint = await config.get('apiEndpoint');

		// disable log output during testing
		sinon.stub(log, 'debug');
		sinon.stub(log, 'warn');
		sinon.stub(log, 'info');
		sinon.stub(log, 'event');
		sinon.stub(log, 'success');
	});

	after(async () => {
		try {
			await testDb.destroy();
		} catch (e) {
			/* noop */
		}
		sinon.restore();
	});

	afterEach(async () => {
		await testDb.reset();
	});

	it('converts target apps into the database format', async () => {
		await dbFormat.setApps(
			{
				deadbeef: {
					id: 1,
					name: 'test-app',
					releases: {
						one: {
							id: 1,
							services: {
								ubuntu: {
									id: 1,
									image_id: 1,
									image: 'ubuntu:latest',
									environment: {},
									labels: { 'my-label': 'true' },
									command: ['sleep', 'infinity'],
								},
							},
							volumes: {},
							networks: {},
						},
					},
				},
			},
			'local',
		);

		const [app] = await testDb.models('app').where({ uuid: 'deadbeef' });
		expect(app).to.not.be.undefined;
		expect(app.name).to.equal('test-app');
		expect(app.releaseId).to.equal(1);
		expect(app.commit).to.equal('one');
		expect(app.appId).to.equal(1);
		expect(app.source).to.equal('local');
		expect(app.uuid).to.equal('deadbeef');
		expect(app.isHost).to.equal(0);
		expect(app.services).to.equal(
			'[{"image":"ubuntu:latest","environment":{},"labels":{"my-label":"true"},"command":["sleep","infinity"],"appId":1,"appUuid":"deadbeef","releaseId":1,"commit":"one","imageId":1,"serviceId":1,"serviceName":"ubuntu"}]',
		);
		expect(app.volumes).to.equal('{}');
		expect(app.networks).to.equal('{}');
	});

	it('should retrieve a single app from the database', async () => {
		await dbFormat.setApps(
			{
				deadbeef: {
					id: 1,
					name: 'test-app',
					releases: {
						one: {
							id: 1,
							services: {
								ubuntu: {
									id: 1,
									image_id: 1,
									image: 'ubuntu:latest',
									environment: {},
									labels: { 'my-label': 'true' },
									command: ['sleep', 'infinity'],
								},
							},
							volumes: {},
							networks: {},
						},
					},
				},
			},
			apiEndpoint,
		);

		// getApp creates a new app instance which requires a docker instance
		// withMockerode mocks engine
		await withMockerode(async () => {
			const app = await dbFormat.getApp(1);
			expect(app).to.be.an.instanceOf(App);
			expect(app).to.have.property('appId').that.equals(1);
			expect(app).to.have.property('commit').that.equals('one');
			expect(app).to.have.property('appName').that.equals('test-app');
			expect(app).to.have.property('source').that.equals(apiEndpoint);
			expect(app).to.have.property('services').that.has.lengthOf(1);
			expect(app).to.have.property('volumes').that.deep.equals({});
			expect(app)
				.to.have.property('networks')
				.that.deep.equals(getDefaultNetwork(1));

			const [service] = app.services;
			expect(service).to.have.property('appId').that.equals(1);
			expect(service).to.have.property('serviceId').that.equals(1);
			expect(service).to.have.property('imageId').that.equals(1);
			expect(service).to.have.property('releaseId').that.equals(1);
			expect(service.config)
				.to.have.property('image')
				.that.equals('ubuntu:latest');
			expect(service.config)
				.to.have.property('labels')
				.that.deep.includes({ 'my-label': 'true' });
			expect(service.config)
				.to.have.property('command')
				.that.deep.equals(['sleep', 'infinity']);
		});
	});

	it('should retrieve multiple apps from the database', async () => {
		await dbFormat.setApps(
			{
				deadbeef: {
					id: 1,
					name: 'test-app',
					releases: {
						one: {
							id: 1,
							services: {
								ubuntu: {
									id: 1,
									image_id: 1,
									image: 'ubuntu:latest',
									environment: {},
									labels: {},
									command: ['sleep', 'infinity'],
								},
							},
							volumes: {},
							networks: {},
						},
					},
				},
				deadc0de: {
					id: 2,
					name: 'other-app',
					releases: {
						two: {
							id: 2,
							services: {},
							volumes: {},
							networks: {},
						},
					},
				},
			},
			apiEndpoint,
		);

		await withMockerode(async () => {
			const apps = Object.values(await dbFormat.getApps());
			expect(apps).to.have.lengthOf(2);

			const [app, otherapp] = apps;
			expect(app).to.be.an.instanceOf(App);
			expect(app).to.have.property('appId').that.equals(1);
			expect(app).to.have.property('commit').that.equals('one');
			expect(app).to.have.property('appName').that.equals('test-app');
			expect(app).to.have.property('source').that.equals(apiEndpoint);
			expect(app).to.have.property('services').that.has.lengthOf(1);
			expect(app).to.have.property('volumes').that.deep.equals({});
			expect(app)
				.to.have.property('networks')
				.that.deep.equals(getDefaultNetwork(1));

			expect(otherapp).to.have.property('appId').that.equals(2);
			expect(otherapp).to.have.property('commit').that.equals('two');
			expect(otherapp).to.have.property('appName').that.equals('other-app');
		});
	});

	it('should retrieve app target state from database', async () => {
		const srcApps = {
			deadbeef: {
				id: 1,
				name: 'test-app',
				releases: {
					one: {
						id: 1,
						services: {
							ubuntu: {
								id: 1,
								image_id: 1,
								image: 'ubuntu:latest',
								environment: {},
								labels: { 'my-label': 'true' },
								command: ['sleep', 'infinity'],
							},
						},
						volumes: {},
						networks: {},
					},
				},
			},
			deadc0de: {
				id: 2,
				name: 'other-app',
				releases: {
					two: {
						id: 2,
						services: {},
						volumes: {},
						networks: {},
					},
				},
			},
		};

		await dbFormat.setApps(srcApps, apiEndpoint);

		// getApp creates a new app instance which requires a docker instance
		// withMockerode mocks engine
		await withMockerode(async () => {
			const result = await dbFormat.getTargetJson();
			expect(
				isRight(TargetApps.decode(result)),
				'resulting target apps is a valid TargetApps object',
			);
			expect(result).to.deep.equal(srcApps);
		});
	});
});
