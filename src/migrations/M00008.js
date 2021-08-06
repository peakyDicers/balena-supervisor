export async function up(knex) {
	await knex.schema.table('app', (table) => {
		table.string('uuid');
		table.unique('uuid');
		table.boolean('isHost').defaultTo(false);
	});

	await knex.schema.table('image', (table) => {
		table.string('appUuid');
		table.string('releaseUuid');
	});

	// Update release uuid on image table
	// on this migration we need to also add app uuids to database images
	// however migrations are ran before the cloud target state is received
	// so that will need to happen on application manager init(?)
	Promise.all(
		(
			await knex('app').select(['appId', 'commit'])
		).map(({ appId, releaseUuid }) =>
			knex('image').where({ appId }).update({ releaseUuid }),
		),
	);
}

export function down() {
	return Promise.reject(new Error('Not Implemented'));
}
