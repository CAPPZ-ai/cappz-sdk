/**
 * COPE node crystallized. Node ID: v15-32-01-check-worker-entry.
 * Provenance: m/44'/144'/100'/principles/cope/v1#marketplace
 *
 * Deploy entry of the check service: registers the model ports (the only module that loads a model client) and
 * serves worker.ts. Tests and library users import worker.ts directly and run without a model.
 */
import worker, { registerModelPorts } from './worker';
import { modelPorts } from './modelPorts';

registerModelPorts(modelPorts);
export default worker;
