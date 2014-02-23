ChannelSwitcher   = require("./ui/ChannelSwitcher.js.coffee").ChannelSwitcher
Notifications     = require("./ui/Notifications.js.coffee").Notifications
Faviconizer       = require("./ui/Faviconizer.js.coffee").Faviconizer
TouchGestures     = require("./ui/TouchGestures.js.coffee").TouchGestures
Options           = require("./options.js.coffee").Options
utility           = require("./utility.js.coffee")
require("./events.js.coffee")()
  # require "./modules/user_info/UserData.js.coffee"

openpgp.initWorker('js/openpgp.worker.js')

# will be removed
window.codingModeActive = -> # sloppy, forgive me
  $("#coding").is ":visible"
window.chatModeActive = ->
  $("#chatting").is ":visible"

window.showPrivateOverlay = ->
  $("#is-private, #info-overlay").show()
  $("#panes").hide()
  $("#channel-password").focus()
window.hidePrivateOverlay = ->
  $("#is-private, #info-overlay").hide()
  $("#panes").show()

window.GlobalUIState = new Backbone.Model
  chatIsPinned: false

DEBUG = true  if typeof DEBUG is "undefined"


faviconizer = new Faviconizer()
notifications = new Notifications()

# Set cookie options
# 14 seems like a good time to keep the cookie around
window.COOKIE_OPTIONS =
  path: "/"
  expires: 14

# require secure cookies if the protocol is https
window.COOKIE_OPTIONS.secure = true if window.location.protocol is "https:"

# determine the echoplexus host based on environment
if window.ua.node_webkit
  if DEBUG
    window.SOCKET_HOST = "http://localhost:8080" # default host for debugging
  else

    # TODO: allow user to connect to any host
    window.SOCKET_HOST = "https://chat.echoplex.us" #Default host
else # web browser
  window.SOCKET_HOST = window.location.origin


$(document).ready ->

  # messy, hacky, but make it safer for now
  turnOffLiveReload = ->
    $(".livereload").attr "checked", false


  $("body").on("mouseenter", ".tooltip-target", (ev) ->
    title = $(this).data("tooltip-title")
    body = $(this).data("tooltip-body")
    tclass = $(this).data("tooltip-class")
    $tooltip = $(tooltipTemplate)
    $target = $(ev.target)
    $target = $target.parents(".tooltip-target")  unless $target.hasClass("tooltip-target")
    targetOffset = $target.offset()
    $tooltip.css(
      left: targetOffset.left + ($target.width() / 2)
      top: targetOffset.top + ($target.height())
    ).addClass(tclass).find(".title").text(title).end().find(".body").text body
    @tooltip_timer = setTimeout(->
      $("body").append $tooltip
      $tooltip.fadeIn()
    , 350)
  ).on "mouseleave", ".tooltip-target", (ev) ->
    clearTimeout @tooltip_timer
    $("body .tooltip").fadeOut ->
      $(this).remove()

  tooltipTemplate = $("#tooltip").html()
  window.notifications = new Notifications()
  $(window).on("blur", ->
    $("body").addClass "blurred"
  ).on "focus mouseenter", ->
    $("body").removeClass "blurred"
    document.title = "echoplexus"
    faviconizer.setConnected()  if typeof window.disconnected is "undefined" or not window.disconnected
    if ua.node_webkit
      win = gui.Window.get()
      win.requestAttention false

  setTimeout (->
    # reconnect the socket manually using the navigator's onLine property
    # don't bind this too early, just in case it interferes with the normal sequence of events
    $(window).on "online", ->
      console.log "attempting to force a sio reconnect"
      # the socket.io reconnect doesn't always fire after waking up from computer sleep
      # I assume this is due to max reconnection attempts being reached while disconnected, but who knows for sure
      # assuming it'll re-use the cnxn params we used below
      io.connect window.location.origin

  ), 5000

  # when the navigator goes offline, we'll attempt to set their icon to reflect that
  # this might be redundant, but is a good assumption when you're not running it on localhost
  $(window).on "offline", ->
    console.log "navigator has no internet connectivity"
    faviconizer.setDisconnected()

  io.connect window.location.origin,
    "connect timeout": 1000
    reconnect: true
    "reconnection delay": 2000
    "max reconnection attempts": 1000

  globalOptions = new Options()
  channelSwitcher = new ChannelSwitcher()
  $("header").append channelSwitcher.$el
  notifications.enable()
  $("span.options").on "click", (ev) ->
    $(this).siblings("div.options").toggle()

  $(window).on "click", ->
    notifications.requestNotificationPermission()

  $("#channel-password").on "keydown", (ev) ->
    if ev.keyCode == 13
      pw = ev.currentTarget.value
      window.events.trigger "channelPassword",
        password: pw
      ev.currentTarget.value = ""

  # hook up global key shortcuts:
  key.filter = -> # stub out the filter method from the lib to enable them globally
    true


  # change channels:
  key "⌘+ctrl+right, alt+k, ctrl+alt+right", ->
    window.events.trigger "nextChannel"
    false

  key "⌘+ctrl+left, alt+j, ctrl+alt+left", ->
    window.events.trigger "previousChannel"
    false

  key "ctrl+shift+c", ->
    window.events.trigger "leaveChannel"
    false


  # quick reply to PM:
  key "ctrl+r", ->
    replyTo = $(".messages:visible .chatMessage.private:not(.me)").last().find(".nick").text().trim()
    $chatInput = $(".chatinput:visible textarea")
    currentBuffer = undefined
    currentBuffer = $chatInput.val()

    # prepend the command and the user string
    $chatInput.val "/w #{reployTo} #{currentBuffer}" if replyTo and currentBuffer.indexOf("/w #{reployTo}") is -1
    false # don't trigger browser's autoreload


  # change tabs:
  tabs = $("#buttons .tabButton")
  activeTabIndex = $("#buttons .active").index()
  key "⌘+ctrl+down, alt+shift+k, alt+shift+d", ->
    activeTabIndex += 1
    activeTabIndex = activeTabIndex % tabs.length # prevent array OOB
    $(tabs[activeTabIndex]).trigger "click"
    false # don't trigger alt+right => "History Forward"

  key "⌘+ctrl+up, alt+shift+j, alt+shift+s", ->
    activeTabIndex -= 1
    # prevent array OOB
    activeTabIndex = tabs.length - 1  if activeTabIndex < 0
    $(tabs[activeTabIndex]).trigger "click"
    false # don't trigger alt+left => "History Back"

  $(".tabButton").on "click", (ev) ->
    ev.preventDefault()
    $(this).removeClass "activity"
    elementSelector = $(this).data("target")

    if $("#{elementSelector}:visible").length is 0
      $(".tabButton").removeClass "active"
      $(this).addClass "active"

      if window.GlobalUIState.get('chatIsPinned')
        $(elementSelector).addClass('pinned-section') # we'll pin the other module we clicked on too
        $("#panes > section").not(elementSelector).not('#chatting').hide() # and hide everything except the #chatting and intended module
      else
        $(elementSelector).removeClass('pinned-section') #
        $("#panes > section").not(elementSelector).hide()

      $(elementSelector).show()

      elementName = elementSelector.replace("#", "") # was an ID, we'll turn it into a nameless string

      window.events.trigger "sectionActive:#{elementName}"


  window.events.on "chat:activity", (data) ->
    $(".button[data-target='#chatting']").addClass "activity"  unless chatModeActive()
    unless document.hasFocus()
      faviconizer.setActivity()
      document.title = "!echoplexus"
      if ua.node_webkit
        win = gui.Window.get()
        win.requestAttention true


  # fire an event that signals we're no longer idle
  $(window).on "keydown mousemove", ->
    window.events.trigger "unidle"

  if utility.isMobile()
    Gestures = new TouchGestures

