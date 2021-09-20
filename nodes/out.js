const CommandParser = require("../src/runtime/CommandParser");
const Utils = require("../src/runtime/Utils");
const got = require('got');
const ConfigMigration = require("../src/migration/ConfigMigration");
const dotProp = require("dot-prop");

const NodeType = 'deconz-output';
module.exports = function (RED) {

    const defaultCommand = {
        type: 'deconz_state',
        domain: 'lights',
        arg: {
            on: {type: 'keep', value: ""},
            alert: {type: 'str', value: ""},
            effect: {type: 'str', value: ""},
            colorloopspeed: {type: 'num', value: ""},
            open: {type: 'keep', value: ""},
            stop: {type: 'keep', value: ""},
            lift: {type: 'num', value: ""},
            tilt: {type: 'num', value: ""},
            group: {type: 'num', value: ""},
            scene: {type: 'num', value: ""},
            target: {type: 'state', value: ""},
            command: {type: 'str', value: "on"},
            payload: {type: 'msg', value: "payload"},
            delay: {type: 'num', value: "2000"},
            transitiontime: {type: 'num', value: ""},
            retryonerror: {type: 'num', value: "0"},
            aftererror: {type: 'continue', value: ""},
            bri: {direction: 'set', type: 'num', value: ""},
            sat: {direction: 'set', type: 'num', value: ""},
            hue: {direction: 'set', type: 'num', value: ""},
            ct: {direction: 'set', type: 'num', value: ""},
            xy: {direction: 'set', type: 'json', value: "[]"}
        }
    };

    const defaultConfig = {
        search_type: 'device',
        device_list: [],
        device_name: '',
        query: '{}',
        commands: [defaultCommand],
        specific: {
            delay: {type: 'num', value: '50'},
            result: {type: 'at_end', value: ''}
        }
    };

    class deConzOut {
        constructor(config) {
            RED.nodes.createNode(this, config);

            let node = this;
            node.config = config;

            node.status({}); //clean

            //get server node
            node.server = RED.nodes.getNode(node.config.server);
            if (!node.server) {
                node.status({
                    fill: "red",
                    shape: "dot",
                    text: "node-red-contrib-deconz/in:status.server_node_error"
                });
                return;
            }

            node.server.on('onStart', () => {
                // Config migration
                let configMigration = new ConfigMigration(NodeType, node.config, node.server);
                let migrationResult = configMigration.applyMigration(node.config, node);
                if (Array.isArray(migrationResult.errors) && migrationResult.errors.length > 0) {
                    migrationResult.errors.forEach(
                        error => console.error(`Error with migration of node ${node.type} with id ${node.id}`, error)
                    );
                }

                // Make sure that all expected config are defined
                node.config = Object.assign({}, defaultConfig, node.config);
            });

            node.cleanTimer = null;

            this.on('input', async (message_in, send, done) => {
                // Wait until the server is ready
                if (node.server.ready === false) {
                    await node.server.waitForReady();
                    if (node.server.ready === false) {
                        //TODO send error, the server is not ready
                        return;
                    }
                }
                //TODO wait for migration ?

                let delay = Utils.getNodeProperty(node.config.specific.delay, this, message_in);
                if (typeof delay !== 'number') delay = 50;

                //clearTimeout(node.cleanTimer);
                let devices = [];
                switch (node.config.search_type) {
                    case 'device':
                        for (let path of node.config.device_list) {
                            devices.push({data: node.server.device_list.getDeviceByPath(path)});
                        }
                        break;
                    case 'json':
                    case 'jsonata':
                        let querySrc = RED.util.evaluateJSONataExpression(
                            RED.util.prepareJSONataExpression(node.config.query, node),
                            message_in,
                            undefined
                        );
                        for (let r of node.server.device_list.getDevicesByQuery(querySrc).matched) {
                            devices.push({data: r});
                        }
                        break;
                }

                let resultMsgs = [];
                let errorMsgs = [];
                let resultTimings = ['never', 'after_command', 'at_end'];
                let resultTiming = Utils.getNodeProperty(node.config.specific.result, this, message_in, resultTimings);
                if (!resultTimings.includes(resultTiming)) resultTiming = 'never';

                for (const [id, saved_command] of node.config.commands.entries()) {
                    // Make sure that all expected config are defined
                    const command = Object.assign({}, defaultCommand, saved_command);
                    if (command.type === 'pause') {
                        await Utils.sleep(Utils.getNodeProperty(command.arg.delay, this, message_in), 2000);
                        continue;
                    }

                    try {
                        let cp = new CommandParser(command, message_in, node);
                        let requests = cp.getRequests(node, devices);
                        for (const request of requests) {
                            try {
                                const response = await got(
                                    node.server.api.url.main() + request.endpoint,
                                    {
                                        method: 'PUT',
                                        retry: Utils.getNodeProperty(command.arg.retryonerror, this, message_in) || 0,
                                        json: request.params,
                                        responseType: 'json',
                                        timeout: 2000 // TODO make configurable ?
                                    }
                                );

                                if (resultTiming !== 'never') {
                                    let result = {};
                                    let errors = [];
                                    for (const r of response.body) {
                                        if (r.success !== undefined)
                                            for (const [enpointKey, value] of Object.entries(r.success))
                                                result[enpointKey.replace(request.endpoint + '/', '')] = value;
                                        if (r.error !== undefined) errors.push(r.error);
                                    }

                                    let resultMsg = {};
                                    if (resultTiming === 'after_command') {
                                        resultMsg = Utils.cloneMessage(message_in, ['request', 'meta', 'payload', 'errors']);
                                        resultMsg.payload = result;
                                    } else if (resultTiming === 'at_end') {
                                        resultMsg.result = result;
                                    }

                                    resultMsg.request = request.params;
                                    resultMsg.meta = request.meta;
                                    if (request.scene_meta !== undefined)
                                        resultMsg.scene_meta = request.scene_meta;
                                    if (errors.length > 0)
                                        resultMsg.errors = errors;

                                    if (resultTiming === 'after_command') {
                                        send(resultMsg);
                                    } else if (resultTiming === 'at_end') {
                                        resultMsgs.push(resultMsg);
                                    }
                                }
                                await Utils.sleep(delay - dotProp.get(response, 'timings.phases.total', 0));
                            } catch (error) {
                                if (resultTiming !== 'never') {
                                    let errorMsg = {};
                                    if (resultTiming === 'after_command') {
                                        errorMsg = Utils.cloneMessage(message_in, ['request', 'meta', 'payload', 'errors']);
                                    }

                                    errorMsg.request = request.params;
                                    errorMsg.meta = request.meta;
                                    errorMsg.errors = [{
                                        type: 0,
                                        code: dotProp.get(error, 'response.statusCode'),
                                        message: dotProp.get(error, 'response.statusMessage'),
                                        description: `${error.name}: ${error.message}`,
                                        apiEndpoint: request.endpoint
                                    }];

                                    if (resultTiming === 'after_command') {
                                        send(errorMsg);
                                    } else if (resultTiming === 'at_end') {
                                        resultMsgs.push(errorMsg);
                                    }
                                }

                                if (Utils.getNodeProperty(command.arg.aftererror, this, message_in, ['continue', 'stop']) === 'stop') return;

                                if (error.timings !== undefined) {
                                    await Utils.sleep(delay - dotProp.get(error, 'timings.phases.total', 0));
                                } else {
                                    await Utils.sleep(delay);
                                }
                            }
                        }
                    } catch (error) {
                        node.error(`Error while processing command #${id + 1}, ${error}`, message_in);
                        console.warn(error);
                    }

                }

                if (resultTiming === 'at_end') {
                    let endMsg = Utils.cloneMessage(message_in, ['payload', 'errors']);
                    endMsg.payload = resultMsgs;
                    if (errorMsgs.length > 0)
                        endMsg.errors = errorMsgs;
                    send(endMsg);
                }

            });

        }

    }

    RED.nodes.registerType(NodeType, deConzOut);
};












