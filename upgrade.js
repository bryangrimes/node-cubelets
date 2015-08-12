var util = require('util')
var events = require('events')
var async = require('async')
var xtend = require('xtend')
var cubelets = require('./client/net')
var Protocol = cubelets.Protocol
var Cubelet = require('./cubelet')
var BlockTypes = Cubelet.BlockTypes
var Program = require('./program')
var InfoService = require('./service/info')
var __ = require('underscore')

var FirmwareType = {
  CLASSIC: 0,
  BOOTSTRAP: 1,
  IMAGO: 2
}

var programs = {}

// 1: detect bluetooth cubelet type:
//     - imago
//     - bootstrap
//     - classic
// 2: flash bluetooth with bootstrap
// 3: attach next classic cubelet
// 4. flash classic cubelet with imago
// 5. detatch imago cubelet
// 6. if another classic cubelet goto 3
// 7. flash bluetooth with imago

var done = false

function detectFirmwareType(client, callback) {
  console.log('detect firmware type')
  client.setProtocol(Protocol.Classic)
  client.ping(function (err) {
    if (!err) {
      callback(null, FirmwareType.CLASSIC)
    } else {
      client.setProtocol(Protocol.Imago)
      client.fetchConfiguration(function (err, config) {
        if (!err) {
          callback(null,
            (config.customApplication === 2) ? 
              FirmwareType.BOOTSTRAP : FirmwareType.IMAGO)
        } else {
          callback(err)
        }
      })
    }
  }, 1000)
}

function flashBootstrapIfNeeded(client, callback) {
  detectFirmwareType(client, function (err, firmwareType) {
    if (err) {
      console.error('could not detect firmware')
    } else if (FirmwareType.BOOTSTRAP !== firmwareType) {
      console.log('flashing bootstrap')
      flashBootstrap(client, callback)
    } else {
      console.log('skipping bootstrap')
      callback(null, client)
    }
  })
}

function flashBootstrap(client, callback) {
  console.log('(flash bootstrap not implemented)')
  callback(null, client)
}

function queueBlocksUntilDone(client, callback) {
  console.log('queue blocks until done')
  var waitingQueue = []
  var doneQueue = []

  function enqueue(q, block) {
    q.unshift(block)
  }

  function peek(q) {
    return q.slice(-1)[0]
  }

  function dequeue(q) {
    return q.pop()
  }

  function exists(q, block) {
    return q.indexOf(block) > -1
  }

  function empty(q) {
    return q.length === 0
  }

  function fetchNeighborBlocks(callback) {
    console.log('fetch neighbor blocks')
    client.fetchNeighborBlocks(function (err, blocks) {
      if (err) {
        callback(err)
      } else {
        fetchBlockInfo(blocks, callback)
      }
    })
  }

  function fetchBlockInfo(blocks, callback) {
    var service = new InfoService()
    service.on('info', function (info, block) {
      var type = Cubelet.typeForTypeId(info.blockTypeId)
      if (type !== BlockTypes.UNKNOWN) {
        block.blockType = type
        if (!exists(waitingQueue, block) && !exists(doneQueue, block)) {
          enqueue(waitingQueue, block)
          console.log('waiting:', waitingQueue)
        }
      }
    })
    service.fetchBlockInfo(blocks, function (err) {
      service.removeAllListeners('info')
      callback(err)
    })
  }

  function flashNextBlock(callback) {
    var block = peek(waitingQueue)
    var typeId = block.type.typeId
    var program = programs[typeId]
    if (!program) {
      callback(new Error('No program found for block type: ' + typeId))
    } else {
      console.log('flashing block', block.blockId)
      client.flashProgramToBlock(program, block, function (err) {
        if (err) {
          callback(err)
        } else {
          enqueue(doneQueue, dequeue(waitingQueue))
          console.log('done:', doneQueue)
          callback(null)
        }
      })
    }
  }

  function wait(callback) {
    var delay = 7500
    console.log('waiting', delay+'ms')
    setTimeout(function () {
      callback(null)
    }, 5000)
  }

  function tryFlashNextBlock(callback) {
    if (empty(waitingQueue)) {
      console.log('no blocks to flash')
      wait(callback)
    } else {
      console.log('flashing next block')
      flashNextBlock(callback)
    }
  }

  async.until(function () {
    return done
  }, function (next) {
    async.series([
      fetchNeighborBlocks,
      tryFlashNextBlock
    ], next)
  }, callback)
}

function flashImago(client, callback) {
  console.log('flash imago')
  callback(null, client)
}

function update(client, callback) {
  console.log('update')
  async.seq(
    flashBootstrapIfNeeded,
    queueBlocksUntilDone,
    flashImago
  )(client, callback)

  this.done = function () {
    done = true
  }
}

var Upgrade = function (client) {
  events.EventEmitter.call(this)

  var self = this

  this.detectIfNeeded = function (callback) {
    detectFirmwareType(client, function (err, firmwareType) {
      if (err) {
        callback(err)
      } else {
        callback(null, (FirmwareType.IMAGO !== firmwareType))
      }
    })
  }

  this.bootstrapBluetoothBlock = function (callback) {
    var p = 0
    var interval = setInterval(function () {
      if (p > 100) {
        clearInterval(interval)
        callback(null)
      } else {
        self.emit('progress', ((p++) / 100.0))
      }
    }, 10)
  }

  var pendingBlocks = []
  var completedBlocks = []
  var activeBlock = null

  function findPendingBlock(block) {
    return __(pendingBlocks).find(function (pendingBlock) {
      return block.blockId === pendingBlock.blockId
    })
  }

  function findCompletedBlock(block) {
    return __(completedBlocks).find(function (completedBlock) {
      return block.blockId === completedBlock.blockId
    })
  }

  function filterUnknownPendingBlocks() {
    return __(pendingBlocks).filter(function (block) {
      return block.blockType === BlockTypes.UNKNOWN
    })
  }

  function fetchUnknownBlockTypes(callback) {
    var unknownBlocks = filterUnknownPendingBlocks()
    var service = new InfoService()
    var changed = false
    service.on('info', function (info, block) {
      var type = Cubelet.typeForTypeId(info.blockTypeId)
      if (type !== BlockTypes.UNKNOWN) {
        block.blockType = type
        changed = true
      }
    })
    service.fetchBlockInfo(unknownBlocks, function (err) {
      service.removeAllListeners('info')
      callback(err)
      if (changed) {
        self.emit('changePendingBlocks')
      }
    })
  }

  function dequeueNextBlockToUpgrade() {
    var index = __(pendingBlocks).findIndex(function (block) {
      return block.blockType !== BlockTypes.UNKNOWN
    })
    if (index > -1) {
      var nextBlock = pendingBlocks[index]
      pendingBlocks.splice(index, 1)
      self.emit('changePendingBlocks')
      return nextBlock
    } else {
      console.log('found no blocks', pendingBlocks)
    }
  }

  function findBlocksToUpgrade(callback) {
    client.fetchAllBlocks(function (err) {
      if (err) {
        callback(err)
      } else {
        __(client.getAllBlocks()).each(function (block) {
          if (!findPendingBlock(block) && !findCompletedBlock(block)) {
            pendingBlocks.push(block)
            self.emit('changePendingBlocks')
          }
        })
        callback(null)
      }
    })
  }

  function waitForUserInput(t) {
    return function (callback) {
      setTimeout(callback, t)
    }
  }

  var done = false

  this.startBlockUpgrades = function (callback) {
    async.until(function () {
      return done
    }, function (next) {
      async.series([
        findBlocksToUpgrade,
        fetchUnknownBlockTypes,
        upgradeNextBlock,
        waitForUserInput(1000)
      ], next)
    }, function (err) {
      if (callback) {
        callback(err)
      }
    })
  }

  function upgradeNextBlock (callback) {
    var nextBlock = dequeueNextBlockToUpgrade()
    if (nextBlock) {
      activeBlock = nextBlock
      self.emit('changeActiveBlock')
      var p = 0
      var interval = setInterval(function () {
        if (p > 100) {
          clearInterval(interval)
          completedBlocks.push(activeBlock)
          self.emit('changeCompletedBlocks')
          if (callback) {
            callback(null)
          }
        } else {
          self.emit('progress', ((p++) / 100.0))
        }
      }, 10)
    } else {
      activeBlock = null
      self.emit('changeActiveBlock')
      if (callback) {
        callback(null)
      }
    }
  }

  this.getPendingBlocks = function () {
    return pendingBlocks
  }

  this.getActiveBlock = function () {
    return activeBlock
  }

  this.getCompletedBlocks = function () {
    return completedBlocks
  }

  this.stopBlockUpgrades = function () {
    done = true
  }

  this.upgradeBluetoothBlock = function (callback) {
    var p = 0
    var interval = setInterval(function () {
      if (p > 100) {
        clearInterval(interval)
        if (callback) {
          callback(null)
        }
      } else {
        self.emit('progress', ((p++) / 100.0))
      }
    }, 10)
  }

}

util.inherits(Upgrade, events.EventEmitter)

module.exports = Upgrade
