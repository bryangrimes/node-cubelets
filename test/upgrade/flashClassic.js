var test = require('tape')
var fs = require('fs')
var config = require('../config')
var cubelets = require('../../index')
var Block = require('../../block')
var BlockTypes = require('../../blockTypes')
var MCUTypes = require('../../mcuTypes')
var UpgradeProtocol = require('../../protocol/bootstrap/upgrade')
var Upgrade = require('../../upgrade')
var ClassicProtocol = require('../../protocol/classic')
var ImagoProtocol = require('../../protocol/imago')
var Program = ClassicProtocol.Program
var Flash = ClassicProtocol.Flash

var bluetoothBlockId = config.map.type.bluetooth

var client = cubelets.connect(config.device, function (err) {
  test('connected', function (t) {
    t.plan(1)
    if (err) {
      t.end(err)
    } else {
      t.pass('connected')

      var upgrade = new Upgrade(client)

      test.skip('detect upgrade firmware?', function (t) {
        t.plan(4)
        upgrade.detectIfNeeded(function (err, needsUpgrade, firmwareType) {
          t.ifError(err, 'detect ok')
          t.equal(firmwareType, 2, 'has upgrade firmware')
          client.sendRequest(new UpgradeProtocol.messages.SetBootstrapModeRequest(0), function (err, response) {
            t.ifError(err, 'set mode ok')
            t.equal(response.mode, 0, 'jumped to os3')
            //TODO: jump to bootloader?
          })
        })
      })

      test('set classic protocol', function (t) {
        t.plan(1)
        client.setProtocol(ClassicProtocol)
        t.pass('set protocol')
      })

      test('flash bluetooth classic firmware', function (t) {
        t.plan(2)
        var hex = fs.readFileSync('./downgrade/hex/bluetooth.hex')
        var program = new Program(hex)
        t.ok(program.valid, 'firmware valid')
        var flash = new Flash(client)
        var block = new Block(bluetoothBlockId, 0, BlockTypes.BLUETOOTH)
        block._mcuType = MCUTypes.AVR
        flash.programToBlock(program, block, function (err) {
          t.ifError(err, 'flash err')
        })
        flash.on('progress', function (e) {
          console.log('progress', '(' + e.progress + '/' + e.total + ')')
        })
      })

      test('disconnect', function (t) {
        t.plan(1)
        client.disconnect(t.ifError)
      })
    }
  })
})
