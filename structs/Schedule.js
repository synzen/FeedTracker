const Feed = require('./Feed.js')
const Article = require('./Article')
const EventEmitter = require('events')
const childProcess = require('child_process')
const batchLogic = require('../methods/concurrent.js')
const BATCH_SIZE = 300

class Schedule extends EventEmitter {
  constructor (processingMethod = 'concurrent', interval, name, keywords) {
    super()
    this.name = name
    this.keywords = keywords
    this.interval = interval
    this.processingMethod = processingMethod !== 'concurrent' && processingMethod !== 'parallel-isolated' ? 'concurrent' : processingMethod
    this.feeds = {}
    this._batchList = []
    this._processorList = []
  }

  async addFeeds (feeds) {
    const toAdd = {}
    if (!Array.isArray(feeds)) throw new TypeError('Argument is Not an array')
    else if (feeds.length === 0) return
    for (let feed of feeds) {
      if (!(feed instanceof Feed)) throw new TypeError('Array contains a non-Feed object')
      else {
        await feed._initialize()
        toAdd[feed.id] = feed
        // this.feeds[feed.id] = feed
      }
    }
    for (let id in toAdd) this.feeds[id] = toAdd[id]
  }

  async addFeed (feed) {
    if (!(feed instanceof Feed)) throw new TypeError('Argument is a not a Feed object')
    await feed._initialize()
    this.feeds[feed.id] = feed
  }

  _run () {
    return new Promise((resolve, reject) => {
      // Generate batch links
      let batch = []

      for (let id in this.feeds) { // options per link
        const feed = this.feeds[id]
        if (Object.keys(batch).length >= BATCH_SIZE) {
          this._batchList.push(batch)
          batch = []
        }
        batch.push(feed.toJSON())
      }
      if (Object.keys(batch).length > 0) this._batchList.push(batch)

      if (this._batchList.length === 0) return // console.log('No links to retrieve')
      switch (this.processingMethod) {
        case 'concurrent':
          this._getBatch(0, this._batchList).then(resolve)
          break
        case 'parallel-isolated':
          this._getBatchParallel().then(resolve)
          break
      }
    })
  }

  _getBatch (batchNumber, batchList) {
    return new Promise((resolve, reject) => {
      if (batchList.length === 0) return
      const currentBatch = batchList[batchNumber]
      const currentBatchLen = currentBatch.length
      let completedLinks = 0

      batchLogic({ currentBatch: currentBatch }, (err, linkCompletion) => {
        if (err) this.emit('err', err)// console.log(err)
        if (linkCompletion.status === 'article') return this.emit('article', new Article(linkCompletion.article), linkCompletion.link)
        if (linkCompletion.status === 'failed') this.emit('err', linkCompletion.err, linkCompletion.link)
        else if (linkCompletion.status === 'success') {
          // console.log('success' + linkCompletion.link)
          this.feeds[linkCompletion.feedJSONId]._ovewriteOldArticles(linkCompletion.seenArticleList) // Only if config.database.uri is a databaseless folder path
        }

        ++this._cycleTotalCount
        if (++completedLinks === currentBatchLen) {
          if (batchNumber !== batchList.length - 1) setTimeout(this._getBatch.bind(this), 200, batchNumber + 1, batchList)
          else {
            resolve()
            return this._finishCycle()
          }
        }
      })
    })
  }

  _getBatchParallel () {
    return new Promise((resolve, reject) => {
      const config = { advanced: { parallel: 2 } }
      const totalBatchLengths = this._batchList.length
      let completedBatches = 0
      let willCompleteBatch = 0
      let indices = []

      function deployProcessor (batchList, index, callback) {
        if (!batchList) return callback()
        let completedLinks = 0
        const currentBatch = batchList[index] // Array of arrays
        const currentBatchLen = currentBatch.length
        this._processorList.push(childProcess.fork('./methods/isolated.js'))

        const processorIndex = this._processorList.length - 1
        const processor = this._processorList[processorIndex]

        processor.on('message', linkCompletion => {
          if (linkCompletion.status === 'article') return this.emit('article', new Article(linkCompletion.article), linkCompletion.link)
          if (linkCompletion.status === 'batch_connected') return callback() // Spawn processor for next batch
          if (linkCompletion.status === 'failed') {
            // console.log('ho1')
            this.emit('err', new Error(linkCompletion.errMessage))
            // console.log('ho2')
          } else if (linkCompletion.status === 'success') {
            // console.log('success' + linkCompletion.link)
            this.feeds[linkCompletion.feedJSONId]._ovewriteOldArticles(linkCompletion.seenArticleList) // Only if config.database.uri is a databaseless folder path
          }
          // console.log('done 1')
          ++this._cycleTotalCount
          if (++completedLinks === currentBatchLen) {
            completedBatches++
            processor.kill()
            if (completedBatches === totalBatchLengths) {
              // console.log('done')
              this._processorList.length = 0
              resolve()
              this._finishCycle()
              this._processorList = []
            }
          }
        })

        processor.send({ currentBatch: currentBatch })
      }

      function spawn (count) {
        for (var q = 0; q < count; ++q) {
          willCompleteBatch++
          deployProcessor.bind(this)(indices.length > 0 ? this._batchList : undefined, indices.length > 0 ? indices.shift() : undefined, () => {
            if (willCompleteBatch < totalBatchLengths) spawn.bind(this)(1)
          })
        }
      }

      if (config.advanced.parallel && config.advanced.parallel > 1) {
        for (var g = 0; g < this._batchList.length; ++g) indices.push(g)
        spawn.bind(this)(config.advanced.parallel)
      } else {
        for (var i = 0; i < this._batchList.length; ++i) { deployProcessor.bind(this)(this._batchList, i) }
      }
    })
  }

  _finishCycle () {
    // console.log('finished cycle')
    this._batchList.length = 0
  }
}

module.exports = Schedule