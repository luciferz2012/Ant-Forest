/*
 * @Author: TonyJiangWJ
 * @Date: 2019-11-11 09:17:29
 * @Last Modified by: TonyJiangWJ
 * @Last Modified time: 2020-07-29 15:55:08
 * @Description: 基于图像识别控件信息
 */
importClass(com.tony.ColorCenterCalculatorWithInterval)
importClass(com.tony.ScriptLogger)
importClass(java.util.concurrent.LinkedBlockingQueue)
importClass(java.util.concurrent.ThreadPoolExecutor)
importClass(java.util.concurrent.TimeUnit)
importClass(java.util.concurrent.CountDownLatch)
let { config: _config } = require('../config.js')(runtime, this)
let singletonRequire = require('../lib/SingletonRequirer.js')(runtime, this)
let _widgetUtils = singletonRequire('WidgetUtils')
let automator = singletonRequire('Automator')
let _commonFunctions = singletonRequire('CommonFunction')
let BaiduOcrUtil = require('../lib/BaiduOcrUtil.js')

let BaseScanner = require('./BaseScanner.js')

let SCRIPT_LOGGER = new ScriptLogger({
  log: function (message) {
    logInfo(message)
  },
  debug: function (message) {
    debugInfo(message)
  },
  error: function (message) {
    errorInfo(message)
  }
})

const SCALE_RATE = _config.device_width / 1080
const checkPoints = []
for (let i = 0; i < 30 * SCALE_RATE; i++) {
  for (let j = 0; j < 30 * SCALE_RATE; j++) {
    if (i == j)
      checkPoints.push([i, j, "#ffffff"])
  }
}
for (let i = 20; i < 30 * SCALE_RATE; i++) {
  for (let j = 30; j > 20 * SCALE_RATE; j--) {
    if (i - 20 === (30 - j)) {
      checkPoints.push([i, j, "#ffffff"])
    }
  }
}

const ImgBasedFriendListScanner = function () {
  BaseScanner.call(this)
  this.threadPool = null
  this.min_countdown_pixels = 10
  this.resolved_pixels = {}
  this.last_check_point = null
  this.last_check_color = null

  this.init = function (option) {
    this.current_time = option.currentTime || 0
    this.increased_energy = option.increasedEnergy || 0
    this.createNewThreadPool()
  }

  this.createNewThreadPool = function () {
    this.threadPool = new ThreadPoolExecutor(_config.thread_pool_size || 4, _config.thread_pool_max_size || 8, 60, TimeUnit.SECONDS, new LinkedBlockingQueue(_config.thread_pool_queue_size || 256))
  }

  this.start = function () {
    this.increased_energy = 0
    this.min_countdown = 10000
    this.min_countdown_pixels = 10
    this.resolved_pixels = {}
    debugInfo('图像分析即将开始')
    return this.collecting()
  }

  /**
   * 目前可能存在误判 帮收和可收 移除和帮收比较接近的可收点
   */
  this.sortAndReduce = function (points, gap) {
    let scaleRate = _config.device_width / 1080
    gap = gap || 100 * scaleRate
    debugInfo(['reduce gap: {}', gap])
    let lastY = -gap - 1
    let lastIsHelp = false
    let resultPoints = []
    if (points && points.length > 0) {
      points.sort((pd1, pd2) => {
        let p1 = pd1.point
        let p2 = pd2.point
        if (p1.y > p2.y) {
          return 1
        } else if (p1.y < p2.y) {
          return -1
        } else {
          return 0
        }
      }).forEach(pointData => {
        let point = pointData.point
        if (point.y - lastY > gap) {
          resultPoints.push(pointData)
          lastY = point.y
          lastIsHelp = pointData.isHelp
        } else {
          if (lastIsHelp || !pointData.isHelp) {
            // 距离过近的丢弃
            debugInfo(['丢弃距离较上一个:{} 比较近的：{}', lastY, JSON.stringify(pointData)])
          } else {
            // 上一个点非帮助 且当前点为帮助点 丢弃上一个点
            let dropLast = resultPoints.splice(resultPoints.length - 1)
            debugInfo(['丢弃上一个距离比较近的非帮助点：{}', JSON.stringify(dropLast)])
            resultPoints.push(pointData)
            lastY = point.y
            lastIsHelp = pointData.isHelp
          }
        }
      })
      debugInfo('重新分析后的点：' + JSON.stringify(resultPoints))
    }
    return resultPoints
  }

  this.destory = function () {
    this.threadPool.shutdownNow()
    this.threadPool = null
  }

  this.scrollUpIfNeeded = function (grayImg) {
    let countdown = new Countdown()
    let region = [parseInt(_config.device_width * 0.3), parseInt(_config.device_height * 0.6), 100, 200]
    let shouldScrollUp = false
    let last_p = null
    if (this.last_check_point) {
      let checkPointColor = grayImg.getBitmap().getPixel(this.last_check_point.x, this.last_check_point.y)
      // e5
      if ((this.last_check_color & 0xFF) === (checkPointColor & 0xFF)) {
        shouldScrollUp = true
        last_p = this.last_check_point
      } else {
        debugInfo([
          '校验点:{} 颜色：{} 不匹配 {}，正常继续',
          JSON.stringify(this.last_check_point), colors.toString(checkPointColor), colors.toString(this.last_check_color)
        ])
      }
    }
    this.last_check_point = images.findColor(grayImg, '#e5e5e5', { region: region })
    if (this.last_check_point) {
      this.last_check_color = grayImg.getBitmap().getPixel(this.last_check_point.x, this.last_check_point.y)
    } else {
      this.last_check_color
    }


    if (shouldScrollUp) {
      debugInfo(['校验点颜色相同，上划重新触发加载，{}', JSON.stringify(last_p)])
      automator.scrollUp()
    }

    if (this.last_check_color) {
      countdown.summary(
        _commonFunctions.formatString(
          '滑动校验 保存校验点数据：[{}] color:{}', JSON.stringify(this.last_check_point),
          colors.toString(this.last_check_color)
        )
      )
    } else {
      countdown.summary('滑动校验 未找到校验点')
    }
  }

  /**
   * 判断指定点区域是否为可收取的小手图标
   * 
   * @param {*} img 
   * @param {*} point 
   */
  this.checkIsCanCollect = function (img, point) {
    
    let height = point.bottom - point.top
    let width = point.right - point.left
    debugForDev(['checkPoints: {}', JSON.stringify(checkPoints)])
    let p = images.findMultiColors(img, "#ffffff", checkPoints, {
      region: [
        point.left + width - width / Math.sqrt(2),
        point.top,
        width / Math.sqrt(2),
        height / Math.sqrt(2)
      ],
      threshold: 0
    })

    let flag = p !== null
    debugInfo(['point: {} 判定结果：{} {}', JSON.stringify(point), flag, JSON.stringify(p)])
    return flag
  }
  /**
   * 执行收集操作
   * 
   * @return { true } if failed
   * @return { minCountdown, lostSomeone } if successful
   */
  this.collecting = function () {
    let screen = null
    let grayScreen = null
    let intervalScreenForDetectCollect = null
    let intervalScreenForDetectHelp = null
    // console.show()
    let countingDownContainers = []
    let count = 0
    let hasNext = true
    let that = this
    do {
      screen = _commonFunctions.checkCaptureScreenPermission(false, 5)
      // 重新复制一份
      grayScreen = images.grayscale(images.copy(screen))
      let originScreen = images.copy(screen)
      intervalScreenForDetectCollect = images.medianBlur(images.interval(grayScreen, '#828282', 1), 5)
      intervalScreenForDetectHelp = images.medianBlur(images.interval(images.copy(screen), _config.can_help_color || '#f99236', _config.color_offset), 5)
      let countdown = new Countdown()
      let waitForCheckPoints = []

      let helpPoints = this.detectHelp(intervalScreenForDetectHelp)
      if (helpPoints && helpPoints.length > 0) {
        waitForCheckPoints = waitForCheckPoints.concat(helpPoints.map(
          helpPoint => {
            return {
              isHelp: true,
              point: helpPoint
            }
          })
        )
      }

      let collectPoints = this.detectCollect(intervalScreenForDetectCollect)
      if (collectPoints && collectPoints.length > 0) {
        waitForCheckPoints = waitForCheckPoints.concat(collectPoints.map(
          collectPoint => {
            return {
              isHelp: false,
              point: collectPoint
            }
          })
        )
      }
      waitForCheckPoints = this.sortAndReduce(waitForCheckPoints)
      countdown.summary('获取可帮助和可能可收取的点')
      if (waitForCheckPoints.length > 0) {
        if (!_config.help_friend) {
          waitForCheckPoints = waitForCheckPoints.filter(p => !p.isHelp)
          debugInfo(['移除帮助收取的点之后：{}', JSON.stringify(waitForCheckPoints)])
        }
        countdown.restart()
        let countdownLatch = new CountDownLatch(waitForCheckPoints.length)
        let listWriteLock = threads.lock()
        let countdownLock = threads.lock()
        let collectOrHelpList = []
        waitForCheckPoints.forEach(pointData => {
          if (pointData.isHelp) {
            this.threadPool.execute(function () {
              let executeSuccess = false
              try {
                let calculator = new ColorCenterCalculatorWithInterval(
                  images.copy(intervalScreenForDetectHelp), _config.device_width - parseInt(200 * SCALE_RATE), pointData.point.x, pointData.point.y
                )
                calculator.setScriptLogger(SCRIPT_LOGGER)
                let point = calculator.getCenterPoint()
                debugInfo('可帮助收取位置：' + JSON.stringify(point))
                try {
                  listWriteLock.lock()
                  collectOrHelpList.push({
                    point: point,
                    isHelp: true
                  })
                } finally {
                  executeSuccess = true
                  countdownLatch.countDown()
                  listWriteLock.unlock()
                  calculator = null
                }
              } catch (e) {
                errorInfo(['线程执行异常: {}', e])
                _commonFunctions.printExceptionStack(e)
              } finally {
                if (!executeSuccess) {
                  countdownLatch.countDown()
                }
              }
            })
          } else {
            this.threadPool.execute(function () {
              let executeSuccess = false
              try {
                let calculator = new ColorCenterCalculatorWithInterval(
                  images.copy(intervalScreenForDetectCollect), _config.device_width - parseInt(200 * SCALE_RATE), pointData.point.x, pointData.point.y
                )
                calculator.setScriptLogger(SCRIPT_LOGGER)
                let point = calculator.getCenterPoint()
                if (that.checkIsCanCollect(images.copy(originScreen), point)) {
                  debugInfo('可能可收取位置：' + JSON.stringify(point))
                  try {
                    listWriteLock.lock()
                    collectOrHelpList.push({ point: point, isHelp: false })
                    countdownLatch.countDown()
                    executeSuccess = true
                  } finally {
                    listWriteLock.unlock()
                  }
                } else {
                  debugInfo('倒计时中：' + JSON.stringify(point) + ' 像素点总数：' + point.regionSame)
                  // 直接标记执行完毕 将OCR请求交给异步处理
                  countdownLatch.countDown()
                  executeSuccess = true
                  if (_config.useOcr && !_config.is_cycle) {
                    let countdownImg = images.clip(grayScreen, point.left, point.top, point.right - point.left, point.bottom - point.top)
                    let base64String = null
                    try {
                      base64String = images.toBase64(countdownImg)
                      if (_config.saveBase64ImgInfo) {
                        debugInfo(['[记录运行数据]像素点数：「{}」倒计时图片：「data:image/png;base64,{}」', point.regionSame, base64String])
                      }
                    } catch (e) {
                      errorInfo('存储倒计时图片失败：' + e)
                      _commonFunctions.printExceptionStack(e)
                    }
                    if (base64String) {
                      if (that.resolved_pixels[point.regionSame]) {
                        debugInfo(['该像素点总数[{}]已校验过，倒计时值为：{}', point.regionSame, that.resolved_pixels[point.regionSame + 'count']])
                        return
                      } else {
                        debugInfo(['该像素点总数[{}]未校验', point.regionSame])
                      }
                      if (point.regionSame >= (_config.ocrThreshold || 2900) && that.min_countdown >= 2) {
                        // 百度识图API获取文本
                        let countdown = config.ocrUseCache ? BaiduOcrUtil.tryGetByCache(base64String, point.regionSame)
                          : BaiduOcrUtil.getDirectly(base64String, point.regionSame)
                        if (isFinite(countdown) && countdown > 0) {
                          try {
                            countdownLock.lock()
                            // 标记该像素点总数的图片已处理过
                            that.resolved_pixels[point.regionSame] = true
                            that.resolved_pixels[point.regionSame + 'count'] = countdown
                            if (countdown < that.min_countdown) {
                              debugInfo('设置最小倒计时：' + countdown)
                              that.min_countdown = countdown
                              that.min_countdown_pixels = point.regionSame
                            }
                            countingDownContainers.push({
                              countdown: countdown,
                              stamp: new Date().getTime()
                            })
                          } finally {
                            countdownLock.unlock()
                          }
                        }

                      } else {
                        debugInfo(['当前倒计时校验最小像素阈值：{} 已获取最小倒计时：{}', (_config.ocrThreshold || 2900), that.min_countdown])
                      }
                    }
                  }
                }
                calculator = null
              } catch (e) {
                errorInfo('线程执行异常' + e)
                _commonFunctions.printExceptionStack(e)
              } finally {
                if (!executeSuccess) {
                  countdownLatch.countDown()
                }
              }
            })
          }
        })
        // 等待五秒
        if (!countdownLatch.await(_config.thread_pool_waiting_time || 5, TimeUnit.SECONDS)) {
          let activeCount = this.threadPool.getActiveCount()
          errorInfo('有线程执行失败 运行中的线程数：' + activeCount)
          // if (activeCount > 0) {
          debugInfo('将线程池关闭然后重建线程池')
          this.threadPool.shutdownNow()
          this.createNewThreadPool()
          // }
        }
        originScreen.recycle()
        countdown.summary('分析所有可帮助和可收取的点')
        if (collectOrHelpList && collectOrHelpList.length > 0) {
          debugInfo(['开始收集和帮助收取，总数：{}', collectOrHelpList.length])
          if (_config.develop_mode) {
            collectOrHelpList.forEach(target => {
              debugInfo(JSON.stringify(target))
            })
          }
          let noError = true
          collectOrHelpList.forEach(point => {
            if (noError) {
              if (false === that.collectTargetFriend(point)) {
                noError = false
              }
            }
          })
          if (!noError) {
            // true is error
            return true
          }
        } else {
          debugInfo('无可收取或帮助的内容')
        }
      }
      automator.scrollDown()
      sleep(300)
      count++
      if (_config.checkBottomBaseImg) {
        screen = _commonFunctions.checkCaptureScreenPermission()
        grayScreen = images.grayscale(screen)
        let reached = _widgetUtils.reachBottom(grayScreen)
        if (reached) {
          // 二次校验，避免因为加载中导致的错误判断
          screen = _commonFunctions.checkCaptureScreenPermission()
          grayScreen = images.grayscale(screen)
          reached = _widgetUtils.reachBottom(grayScreen)
        }
        hasNext = !reached
      } else {
        hasNext = count < (_config.friendListScrollTime || 30)
      }
      // 每5次滑动判断一次是否在排行榜中
      if (hasNext && count % 5 == 0) {
        if (!_widgetUtils.friendListWaiting()) {
          errorInfo('当前不在好友排行榜！')
          // true is error
          return true
        }
        // TODO 列表加载失败，重新上划 触发加载
        screen = _commonFunctions.checkCaptureScreenPermission()
        grayScreen = images.grayscale(screen)
        this.scrollUpIfNeeded(images.copy(grayScreen))
      }
    } while (hasNext)
    sleep(100)
    if (!_widgetUtils.friendListWaiting()) {
      errorInfo('当前不在好友排行榜！')
      // true is error
      return true
    }
    let poolWaitCount = 0
    while (this.threadPool.getActiveCount() > 0) {
      debugInfo(['当前线程池还有工作线程未结束，继续等待。运行中数量：{}', this.threadPool.getActiveCount()])
      sleep(100)
      poolWaitCount++
      // 当等待超过两秒时 结束线程池
      if (poolWaitCount > 20) {
        warnInfo(['线程池等待执行结束超时，当前剩余运行中数量：{} 强制结束', this.threadPool.getActiveCount()])
        this.threadPool.shutdownNow()
        this.threadPool = new ThreadPoolExecutor(4, 8, 60, TimeUnit.SECONDS, new LinkedBlockingQueue(256))
        break
      }
    }

    this.checkRunningCountdown(countingDownContainers)

    return this.getCollectResult()
  }

  this.detectHelp = function (img) {
    let helpPoints = this.detectColors(img)
    debugInfo('可帮助的点：' + JSON.stringify(helpPoints))
    return helpPoints
  }

  this.detectCollect = function (img) {
    let collectPoints = this.detectColors(img)
    debugInfo('可收取的点：' + JSON.stringify(collectPoints))
    return collectPoints
  }

  this.detectColors = function (img) {
    let use_img = images.copy(img)
    let movingY = parseInt(180 * SCALE_RATE)
    let movingX = parseInt(100 * SCALE_RATE)
    debugInfo(['moving window size: [{},{}]', movingX, movingY])
    // 预留70左右的高度
    let endY = _config.device_height - movingY - 70 * SCALE_RATE
    let runningY = 440 * SCALE_RATE
    let startX = _config.device_width - movingX
    let regionWindow = []
    let findColorPoints = []
    let countdown = new Countdown()
    let hasNext = true
    do {
      if (runningY > endY) {
        runningY = endY
        hasNext = false
      }
      regionWindow = [startX, runningY, movingX, movingY]
      debugForDev('检测区域：' + JSON.stringify(regionWindow))
      let point = images.findColor(use_img, '#FFFFFF', {
        region: regionWindow
      })
      if (_config.develop_mode) {
        countdown.summary('检测初始点')
      }
      if (point) {
        findColorPoints.push(point)
      }
      runningY += movingY
      countdown.restart()
    } while (hasNext)
    return findColorPoints
  }
}

ImgBasedFriendListScanner.prototype = Object.create(BaseScanner.prototype)
ImgBasedFriendListScanner.prototype.constructor = ImgBasedFriendListScanner

ImgBasedFriendListScanner.prototype.returnToListAndCheck = function () {
  automator.back()
  sleep(500)
  let returnCount = 0
  while (!_widgetUtils.friendListWaiting()) {
    if (returnCount++ === 2) {
      // 等待两秒后再次触发
      automator.back()
    }
    if (returnCount > 5) {
      errorInfo('返回好友排行榜失败，重新开始')
      return false
    }
  }
}

ImgBasedFriendListScanner.prototype.collectTargetFriend = function (obj) {
  if (!obj.protect) {
    //automator.click(obj.target.centerX(), obj.target.centerY())
    debugInfo(['等待进入好友主页, 位置：「{}, {}」设备宽高：[{}, {}]', obj.point.x, obj.point.y, _config.device_width, _config.device_height])
    if (_config.develop_mode) {
      let screen = _commonFunctions.checkCaptureScreenPermission()
      let startY = obj.point.y - 32
      let height = _config.device_height - startY > 190 ? 190 : _config.device_height - startY - 1
      let rangeImg = images.clip(screen, 0, startY, _config.device_width, height)
      let base64 = images.toBase64(rangeImg)
      debugForDev(['点击区域「{}, {}」startY:{} 图片信息：「data:image/png;base64,{}」', obj.point.x, obj.point.y, startY, base64], false, true)
    }
    let restartLoop = false
    let count = 1
    automator.click(obj.point.x, obj.point.y)
    ///sleep(1000)
    while (!_widgetUtils.friendHomeWaiting()) {
      debugInfo(
        '未能进入主页，尝试再次进入 count:' + count++
      )
      automator.click(obj.point.x, obj.point.y)
      sleep(500)
      if (count >= 3) {
        warnInfo('重试超过3次，取消操作')
        restartLoop = true
        break
      }
    }
    if (restartLoop) {
      errorInfo('页面流程出错，重新开始')
      return false
    }
    let title = textContains('的蚂蚁森林')
      .findOne(_config.timeout_findOne)
      .text().match(/(.*)的蚂蚁森林/)
    if (title) {
      obj.name = title[1]
      debugInfo(['进入好友[{}]首页成功', obj.name])
    } else {
      errorInfo(['获取好友名称失败，请检查好友首页文本"XXX的蚂蚁森林"是否存在'])
    }
    let skip = false
    if (!skip && _config.white_list && _config.white_list.indexOf(obj.name) >= 0) {
      debugInfo(['{} 在白名单中不收取他', obj.name])
      skip = true
    }
    if (!skip && _commonFunctions.checkIsProtected(obj.name)) {
      warnInfo(['{} 使用了保护罩 不收取他', obj.name])
      skip = true
    }
    if (!skip && !obj.recheck && this.protectInfoDetect(obj.name)) {
      warnInfo(['{} 好友已使用能量保护罩，跳过收取', obj.name])
      skip = true
    }
    if (skip) {
      return this.returnToListAndCheck()
    }
    return this.doCollectTargetFriend(obj)
  }
  return true
}

ImgBasedFriendListScanner.prototype.checkRunningCountdown = function (countingDownContainers) {
  if (!_config.is_cycle && countingDownContainers.length > 0) {
    debugInfo(['倒计时中的好友数[{}]', countingDownContainers.length])
    let that = this
    countingDownContainers.forEach((item, idx) => {
      if (item.countdown <= 0) {
        return
      }
      let now = new Date()
      let stamp = item.stamp
      let count = item.countdown
      let passed = Math.round((now - stamp) / 60000.0)
      debugInfo([
        '需要计时[{}]分 经过了[{}]分 计时时间戳[{}]',
        count, passed, stamp
      ])
      if (passed >= count) {
        debugInfo('有一个记录倒计时结束')
        // 标记有倒计时结束的漏收了，收集完之后进行第二次收集
        that.recordLost('有倒计时结束')
      } else {
        let rest = count - passed
        that.min_countdown = rest < that.min_countdown ? rest : that.min_countdown
      }
    })
  }
}

function Countdown () {
  this.start = new Date().getTime()
  this.getCost = function () {
    return new Date().getTime() - this.start
  }

  this.summary = function (content) {
    debugInfo(content + ' 耗时' + this.getCost() + 'ms')
  }

  this.restart = function () {
    this.start = new Date().getTime()
  }

}
module.exports = ImgBasedFriendListScanner