var through = require('through2')
var Version = require('./version')
var BlockTypes = require('./blockTypes')
var Protocol = require('./protocol/imago')
var Message = Protocol.Message
var __ = require('underscore')

function Demo(socket, opts) {
  var blockId = 1337
  var hardwareVersion = new Version(2, 0, 0)
  var bootloaderVersion = new Version(4, 0, 0)
  var applicationVersion = new Version(4, 0, 0)
  var mode = 1
  var customApplication = 0

  var blocks = []
  var valueEvents = {}

  function getOriginBlock() {
    return blocks[0]
  }

  function getBlocks() {
    return __(blocks).rest(1)
  }

  function addBlock(block) {
    blocks.push(block)
  }

  function removeBlock(block) {
    var i = blocks.indexOf(block)
    if (i > -1) {
      blocks.splice(i, 1)
    }
  }

  var parser = new Protocol.Parser()
  var messages = Protocol.messages

  var replies = {}
  function reply(Request, handler) {
    replies[Request.code] = function (req) {
      handler(req)
    }
  }

  reply(messages.GetConfigurationRequest, function (req) {
    var res = new messages.GetConfigurationResponse()
    console.log('get configuration?', req)
    res.blockId = blockId
    res.hardwareVersion = hardwareVersion
    res.bootloaderVersion = bootloaderVersion
    res.applicationVersion = applicationVersion
    res.mode = mode
    res.customApplication = customApplication
    send(res)
  })

  reply(messages.GetModeRequest, function (req) {
    console.log('get mode?', req)
    send(new messages.GetModeResponse(mode))
  })

  reply(messages.EchoRequest, function (req) {
    console.log('echo?', req)
    send(new messages.EchoResponse(req.echo))
  })

  reply(messages.GetNeighborBlocksRequest, function (req) {
    console.log('get neighbor blocks?', req)
    var neighborIds = getOriginBlock().neighborIds
    var neighbors = __(neighborIds).reduce(function (memo, blockId, faceIndex) {
      if (null !== blockId) {
        memo[faceIndex] = blockId
      }
      return memo
    }, {})
    send(new messages.GetNeighborBlocksResponse(neighbors))
  })

  reply(messages.GetAllBlocksRequest, function (req) {
    console.log('get all blocks?', req)
    var blocks = getBlocks()
    send(new messages.GetAllBlocksResponse(blocks))
  })

  reply(messages.RegisterBlockValueEventRequest, function (req) {
    console.log('register block value event?', req)
    var blockId = req.blockId
    valueEvents[blockId] = true
    startEventQueue()
    send(new messages.RegisterBlockValueEventResponse(0))
  })

  reply(messages.UnregisterBlockValueEventRequest, function (req) {
    console.log('unregister block value event?', req)
    var blockId = req.blockId
    delete valueEvents[blockId]
    send(new messages.UnregisterBlockValueEventResponse(0))
  })

  reply(messages.UnregisterAllBlockValueEventsRequest, function (req) {
    console.log('unregister all block value events?', req)
    var blockId = req.blockId
    valueEvents = {}
    send(new messages.UnregisterAllBlockValueEventsResponse(0))
  })

  reply(messages.WriteBlockMessageRequest, function (req) {
    console.log('write block message?')
    send(new messages.WriteBlockMessageResponse(0))

    var b = Protocol.Block.messages
    var PingRequest = b.PingRequest
    var PongResponse = b.PongResponse
    var GetConfigurationRequest = b.GetConfigurationRequest
    var GetConfigurationResponse = b.GetConfigurationResponse
    var GetNeighborsRequest = b.GetNeighborsRequest
    var GetNeighborsResponse = b.GetNeighborsResponse

    var blockRequest = req.blockMessage
    var blockId = blockRequest.blockId

    switch (blockRequest.code()) {
      case PingRequest.code:
        sendReadBlockMessageEvent(new PongResponse(blockId, blockRequest.payload))
        break
      case GetConfigurationRequest.code:
        var res = new GetConfigurationResponse(blockId)
        res.hardwareVersion = hardwareVersion
        res.bootloaderVersion = bootloaderVersion
        res.applicationVersion = applicationVersion
        res.mode = mode
        res.customApplication = customApplication
        res.blockTypeId = BlockTypes.UNKNOWN
        var block = __(blocks).find(function (block) {
          return block.blockId === blockId
        })
        if (block) {
          res.blockTypeId = block.blockType.typeId
          sendReadBlockMessageEvent(res, rand(300))
        }
        break
      case GetNeighborsRequest.code:
        var res = new GetNeighborsResponse(blockId)
        var block = __(blocks).find(function (block) {
          return block.blockId === blockId
        })
        if (block) {
          var neighbors = {}
          __(block.neighborIds).each(function (neighborId, i) {
            if (null !== neighborId) {
              neighbors[i] = neighborId
            }
          })
          res.neighbors = neighbors
          sendReadBlockMessageEvent(res, rand(300 * block.hopCount))
        }
        break
    }

    function sendReadBlockMessageEvent(blockResponse, delay) {
      setTimeout(function () {
        send(new messages.ReadBlockMessageEvent(blockResponse))
      }, delay||0)
    }
  })

  reply(messages.UploadToMemoryRequest, function (req) {
    console.log('upload to memory?', req)
    // TODO: send progress events
    // var lineSize = 18
    // var progress = 0
    // var total = req.slotSize * lineSize
    // parser.setRawMode(true)
    // parser.on('raw', function listener(data) {
    //   progress += data.length
    //   console.log('progress', progress)
    //   if (progress >= slotSize) {
    //     parser.removeListener('raw', listener)
    //     parser.setRawMode(false)
    //     var extra = progress - slotSize
    //     parser.parse(data.slice(data.length - extra))
    //     console.log('parsing', extra, 'extra bytes')
    //   }
    // })
    send(new messages.UploadToMemoryResponse(0))
    setTimeout(function () {
      send(new messages.UploadToMemoryCompleteEvent())
    }, 1000)
  })

  reply(messages.FlashMemoryToBlockRequest, function (req) {
    console.log('flash memory to block?', req)
    // TODO: add flashing mutex
    var blockId = req.blockId
    var delay = 1000
    var count = 1
    var i = 0
    var size = 4000 // TODO: look up size in slotIndex
    // var interval = setInterval(function () {
    //   var progress = Math.ceil(i / count * size)
    //   send(new messages.FlashProgressEvent(blockId, progress))
    //   i++
    // }, delay)
    setTimeout(function () {
      // clearInterval(interval)
      send(new messages.FlashMemoryToBlockResponse(0))
    }, count * delay)
  })

  parser.on('message', function (msg) {
    var code = msg.code()
    var reply = replies[code]
    if (typeof reply === 'function') {
      reply(msg)
      stream.emit('request', msg)
    } else {
      stream.emit('command', msg)
    }
  })

  var stream = through(function write(chunk, enc, next) {
    socket.write(chunk, enc, next)
  })

  socket.on('data', function (chunk) {
    parser.parse(chunk)
  })

  socket.on('end', function () {
    stream.end()
  })

  function send(msg) {
    stream.write(msg.encode())
  }

  var eventQueue = null

  function startEventQueue() {
    if (eventQueue) {
      return
    }
    var time = 0
    var interval = 100
    eventQueue = setInterval(function () {
      if (__(valueEvents).keys().length > 0) {
        var blocks = __(valueEvents).map(function (e, blockId) {
          return {
            blockId: parseInt(blockId, 10),
            value: Math.floor(255 * Math.abs(Math.sin(2 * Math.PI * (time % 5000) / 5000)))
          }
        })
        send(new messages.BlockValueEvent(blocks))
        time += interval
      } else {
        clearInterval(eventQueue)
        eventQueue = null
      }
    }, interval)
  }

  stream.addBlock = addBlock
  stream.removeBlock = removeBlock
  stream.getBlocks = getBlocks

  function mutation0() {
    var bluetooth = blockId
    var drive1 = 10004
    var drive2 = 10010
    var distance1 = 10005
    var distance2 = 10015
    var inverse = 22496
    var battery = 31852
    var rotate = 48200
    return [{
      blockId: bluetooth,
      blockType: BlockTypes.BLUETOOTH,
      hopCount: 0,
      neighborIds: [ drive2, null, drive1, rotate, null, inverse ]
    },{
      blockId: drive1,
      blockType: BlockTypes.DRIVE,
      hopCount: 1,
      neighborIds: [ bluetooth, null, null, null, null, distance1 ]
    },{
      blockId: drive2,
      blockType: BlockTypes.DRIVE,
      hopCount: 1,
      neighborIds: [ null, null, bluetooth, null, null, distance2 ]
    },{
      blockId: distance1,
      blockType: BlockTypes.DISTANCE,
      hopCount: 2,
      neighborIds: [ null, null, inverse, null, drive1, null ]
    },{
      blockId: distance2,
      blockType: BlockTypes.DISTANCE,
      hopCount: 2,
      neighborIds: [ inverse, null, null, null, drive1, null ]
    },{
      blockId: inverse,
      blockType: BlockTypes.INVERSE,
      hopCount: 1,
      neighborIds: [ distance2, null, distance1, battery, bluetooth, null ]
    },{
      blockId: battery,
      blockType: BlockTypes.BATTERY,
      hopCount: 2,
      neighborIds: [ null, inverse, null, null, rotate, null ]
    },{
      blockId: rotate,
      blockType: BlockTypes.ROTATE,
      hopCount: 1,
      neighborIds: [ null, bluetooth, null, null, null, battery ]
    }]
  }

  var mutations = [
    mutation0()
  ]

  function mutate() {
    blocks = []
    any(mutations).forEach(addBlock)
  }

  function rand(n) {
    return Math.floor(n * Math.random())
  }

  function any(A) {
    return A[rand(A.length)]
  }

  function choices(n) {
    var map = {}

    var stride = (n / 2)
    var i = rand(n)
    var max = 0
    
    this.choose = function () {
      if (max === n) {
        return -1
      } else {
        var x = i
        while (map[x]) {
          i = (i + rand(stride)) % n
          x = i
        }
        map[x] = true
        max++
        return x
      }
    }

    this.without = function (x) {
      map[x] = true
      max++
      return this
    }
  }

  mutate()

  return stream
}

module.exports = Demo

var Strategy = {
  Classic: function (demo) {

  },
  Imago: function (demo) {

  }
}