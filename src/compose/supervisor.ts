import * as memoizee from 'memoizee';
import { docker } from '../lib/docker-utils';
import * as constants from '../lib/constants';
import log from '../lib/supervisor-console';

export type SupervisorService = {
	uuid?: string;
	serviceName?: string;
};

/**
 * Return the supervisor service instance
 */
export const getSupervisorService = memoizee(async () => {
	const supervisorService: SupervisorService = {};

	try {
		const container = await docker
			.getContainer(constants.containerId)
			.inspect();

		const { Labels } = container.Config;
		supervisorService.uuid = Labels['io.balena.app-uuid'];
		supervisorService.serviceName = Labels['io.balena.service-name'];
	} catch (e) {
		log.warn(
			`Failed to query supervisor container with id ${constants.containerId}`,
		);
	}
	return supervisorService;
});
