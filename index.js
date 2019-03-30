const mqtt = require('mqtt')
const _ = require('lodash')
const logging = require('homeautomation-js-lib/logging.js')
const repeat = require('repeat')
const health = require('homeautomation-js-lib/health.js')
const request = require('request')
var parseString = require('xml2js').parseString

require('homeautomation-js-lib/mqtt_helpers.js')


const fix_name = function(str) {
	str = str.replace(/[+\\&*%$#@!]/g, '')
	str = str.replace(/\s/g, '_').trim().toLowerCase()
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
const client = mqtt.setupClient(connectedEvent, disconnectedEvent)


const query_egauge_host = function(host, callback) {
	const urlSuffix = '/cgi-bin/egauge?inst'
	const url = 'http://' + host + urlSuffix
	logging.info('eGauge request url: ' + url)

	request.get({url: url, json: true},
		function(err, httpResponse, body) {
			logging.debug('url:' + url)
			logging.debug('error:' + err)
			logging.debug('httpResponse:' + httpResponse)
			logging.debug('body:' + body)

			if (callback !== null && callback !== undefined) {
				return callback(err, body)
			}
		})
}

const checkHosts = function() {
	var fullJSON = {}

	egauge_hosts.forEach(host => {
		query_egauge_host(host, function(err, result) {
			if ( !_.isNil(err) ) {
				health.unhealthyEvent()
				return
			}

			parseString(result, function(err, result) {
				if ( _.isNil(result.data) ) {
					health.unhealthyEvent()
					return
				}

				if ( _.isNil(result.data.r) ) {
					health.unhealthyEvent()
					return
				}

				const data = result.data.r

				Object.keys(data).forEach(register => {
					const registerData = data[register]['$']
					const reading = data[register]['i']
					const name = registerData.n

					if ( _.isNil(registerData) ) {
						health.unhealthyEvent()
						return
					}
    
					if ( _.isNil(reading) ) {
						health.unhealthyEvent()
						return
					}
    
					if ( _.isNil(name) ) {
						health.unhealthyEvent()
						return
					}
                    
					if ( reading == 1  && name == 'Dryer' ) {
						logging.info('reading of 1 for: registerData: ' + JSON.stringify(registerData))
						logging.info('reading of 1 for: data: ' + JSON.stringify(data))
						return
					}

					fullJSON[fix_name(name)] = reading[0]
					client.smartPublish(topic_prefix + '/' + name.toString(), reading.toString())
				})

				health.healthyEvent()            
			})
		})
	})
}


const startHostCheck = function() {
	logging.info('Starting to monitor: ' + JSON.stringify(egauge_hosts))
	repeat(checkHosts).every(1, 's').start.in(1, 'sec')
}

startHostCheck()
