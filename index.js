const mqtt = require('mqtt')
const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')
const interval = require('interval-promise')
const health = require('homeautomation-js-lib/health.js')
const got = require('got')
var parseString = require('xml2js').parseString
const mqtt_helpers = require('homeautomation-js-lib/mqtt_helpers.js')

const fix_name = function(str) {
    str = str.replace(/[+\\&*%$#@!]/g, '')
    str = str
        .replace(/\s/g, '_')
        .trim()
        .toLowerCase()
    str = str.replace(/__/g, '_')
    return str
}

// Config
var topic_prefix = process.env.TOPIC_PREFIX
var egauge_hosts = process.env.EGAUGE_HOSTS.toString().split(',')

if (_.isNil(topic_prefix)) {
    logging.warn('TOPIC_PREFIX not set, not starting')
    process.abort()
}

var mqttOptions = {}

var shouldRetain = process.env.MQTT_RETAIN

if (_.isNil(shouldRetain)) {
    shouldRetain = false
}

if (!_.isNil(shouldRetain)) {
    mqttOptions['retain'] = shouldRetain
}

var connectedEvent = function() {
    health.healthyEvent()
}

var disconnectedEvent = function() {
    health.unhealthyEvent()
}

// Setup MQTT
const client = mqtt_helpers.setupClient(connectedEvent, disconnectedEvent)

async function query_egauge_host(host, callback) {
    const urlSuffix = '/cgi-bin/egauge?inst&tot'
    const url = 'http://' + host + urlSuffix
    logging.info('eGauge request url: ' + url)
    var error = null
    var body = null

    try {
        const response = await got.get(url)
        body = response.body
    } catch (e) {
        logging.error('failed querying host: ' + e)
        error = e
    }

    if (!_.isNil(callback)) {
        return callback(error, body)
    }
}

var runningDatapoints = {}
var skippedReadings = {}
const maxDataPoints = 5

const addDatapointForRegister = function(register, datapoint) {
    var array = runningDatapoints[register]
    if (_.isNil(array)) {
        array = []
    }

    array.push(Number(datapoint))

    if (array.length > maxDataPoints) {
        array = array.slice(1, maxDataPoints + 1)
    }

    runningDatapoints[register] = array
}

const numberOfDatapointsForRegister = function(register) {
    const array = runningDatapoints[register]
    if (_.isNil(array)) {
        return 0
    }

    return array.length
}

const averageOfRegister = function(register) {
    const datapoints = runningDatapoints[register]
    var total = 0;

    for (var i = 0; i < datapoints.length; i++) {
        total += datapoints[i];
    }

    return total / datapoints.length;
}

const setSkipReading = function(register, skipped) {
    if (skipped)
        skippedReadings[register] = true
    else
        delete skippedReadings[register]
}

const skippedReading = function(register) {
    const found = skippedReadings[register]

    if (!_.isNil(found)) {
        return true
    }

    return false
}

const checkHosts = function() {
    egauge_hosts.forEach(host => {
        query_egauge_host(host, function(err, result) {
            if (!_.isNil(err)) {
                health.unhealthyEvent()
                return
            }

            parseString(result, function(err, result) {
                if (_.isNil(result.data)) {
                    health.unhealthyEvent()
                    return
                }

                if (_.isNil(result.data.r)) {
                    health.unhealthyEvent()
                    return
                }

                const data = result.data.r

                Object.keys(data).forEach(register => {
                    const registerData = data[register]['$']
                    const reading = data[register]['i']
                    const name = registerData.n

                    if (_.isNil(registerData)) {
                        health.unhealthyEvent()
                        return
                    }

                    if (_.isNil(reading)) {
                        health.unhealthyEvent()
                        return
                    }

                    if (_.isNil(name)) {
                        health.unhealthyEvent()
                        return
                    }

                    var skip_reading = false
                    const datapoints = numberOfDatapointsForRegister(name)

                    if (reading == 1 && skippedReading(name) == false) {
                        if (datapoints >= maxDataPoints) {
                            const average = averageOfRegister(name)
                            if (average < -5 || average > 5) {
                                logging.debug('******* SKIPPING WEIRD ' + reading + ' READING FOR: ' + name + ' average was: ' + average)
                                skip_reading = true
                                setSkipReading(name, true)
                            }
                        }
                    } else if (skippedReading(name) == true) {
                        const average = averageOfRegister(name)
                        logging.debug('average for register (' + name + '): ' + average + '   new reading is: ' + reading)
                        if (reading > (average * 1.8)) {
                            logging.debug('****** SKIPPING [HIGH] WEIRD ' + reading + ' READING FOR: ' + name + ' average was: ' + average)
                            skip_reading = true
                        }
                        setSkipReading(name, false)
                    }

                    if (!skip_reading) {
                        setSkipReading(name, skip_reading)
                        addDatapointForRegister(name, reading)
                        client.smartPublish(topic_prefix + '/' + name.toString(), reading.toString())
                    }
                })

                health.healthyEvent()
            })
        })
    })
}

const startHostCheck = function() {
    logging.info('Starting to monitor: ' + JSON.stringify(egauge_hosts))
    interval(async() => {
        checkHosts()
    }, 1 * 1000)
}

startHostCheck()