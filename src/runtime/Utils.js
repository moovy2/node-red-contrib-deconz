const REDUtil = require("@node-red/util/lib/util");

class Utils {
    static sleep(ms, defaultValue) {
        if (typeof ms !== 'number') ms = defaultValue;
        return new Promise((resolve) => setTimeout(() => resolve(), ms));
    }


    static getNodeProperty(property, node, message_in) {
        return REDUtil.evaluateNodeProperty(property.value, property.type, node, message_in);
    }

}

module.exports = Utils;
