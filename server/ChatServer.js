exports.ChatServer = function (sio, redisC) {

	var config = require('./config.js').Configuration,
		CHATSPACE = "/chat",
		async = require('async'),
		spawn = require('child_process').spawn,
		fs = require('fs'),
		crypto = require('crypto'),
		PUBLIC_FOLDER = __dirname + '/public',
		SANDBOXED_FOLDER = PUBLIC_FOLDER + '/sandbox',
		Client = require('../client/client.js').ClientModel,
		Clients = require('../client/client.js').ClientsCollection,
		REGEXES = require('../client/regex.js').REGEXES;

	function urlRoot(){
		if (config.host.USE_PORT_IN_URL) {
			return config.host.SCHEME + "://" + config.host.FQDN + ":" + config.host.PORT + "/";
		} else {
			return config.host.SCHEME + "://" + config.host.FQDN + "/";
		}
	}

	function serverSentMessage (msg, room) {
		return _.extend(msg, {
			nickname: config.features.SERVER_NICK,
			type: "SYSTEM",
			timestamp: Number(new Date()),
			room: room
		});
	}

	function publishUserList (room) {
		if (channels[room] === undefined) {
			console.warn("Publishing userlist of a channel that doesn't exist...", room);
			return;
		}
		sio.of(CHATSPACE).in(room).emit('userlist:' + room, {
			users: channels[room].clients.toJSON(),
			room: room
		});
	}

	function userJoined (client, room) {
		sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
			body: client.get("nick") + ' has joined the chat.',
			client: client.toJSON(),
			cid: client.cid,
			class: "join"
		}, room));
		publishUserList(room);
	}
	function userLeft (client, room) {
		sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
			body: client.get("nick") + ' has left the chat.',
			clientID: client.cid,
			class: "part",
			log: false
		}, room));
	}

	function Channel (name) {
		this.clients = new Clients();
		return this;
	}
	var channels = {};

	function subscribeSuccess (socket, client, room) {
		// let the newly connected client know the ID of the latest logged message
		redisC.hget("channels:currentMessageID", room, function (err, reply) {
			if (err) throw err;
			socket.emit('chat:currentID:' + room, {
				ID: reply,
				room: room
			});
		});
		// global topic:
		redisC.hget('topic', room, function (err, reply){
			if (client.get("room") !== room) return;
			socket.emit('topic:' + room, serverSentMessage({
				body: reply,
				log: false,
			}, room));
		});
		// tell everyone about the new client in the room
		userJoined(client, room);
		// let them know their cid
		socket.emit("chat:your_cid:" + room, {
			room: room,
			cid: client.cid
		});
	}



	var CHAT = sio.of(CHATSPACE).on('connection', function (socket) {
		socket.on("subscribe", function (data, subscribeAck) {
			console.log("client connected, leaving default room");
			socket.leave("\"\"");
			var room = data.room,
				client;

			// console.log(socket);

			var chatEvents = {
				"make_public": function (data) {

					redisC.hget("channels:" + room, "isPrivate", function (err, reply) {
						if (err) throw err;
						if (reply === "true") { // channel is not currently private
							async.parallel([
								function (callback) {
									redisC.hdel("channels:" + room, "isPrivate", callback);
								}, function (callback) {
									redisC.hdel("channels:" + room, "salt", callback);
								}, function (callback) {
									redisC.hdel("channels:" + room, "password", callback);
								}
							], function (err, reply) {
								if (err) throw err;
								socket.emit('chat:' + room, serverSentMessage({
									body: "This channel is now public."
								}, room));
							});
						} else {
							socket.emit('chat:' + room, serverSentMessage({
								body: "This channel is already public."
							}, room));
						}
					});
				},
				"make_private": function (data) {

					redisC.hget("channels:" + room, "isPrivate", function (err, reply) {
						if (err) throw err;
						if (!reply) { // channel is not currently private
							try { // try crypto & persistence
								crypto.randomBytes(256, function (ex, buf) {
									if (ex) throw ex;
									var salt = buf.toString();
									
									crypto.pbkdf2(data.password, salt, 4096, 256, function (err, derivedKey) {
										if (err) throw err;

										async.parallel([
											function (callback) {
												redisC.hset("channels:" + room, "isPrivate", true, callback);
											}, function (callback) {
												redisC.hset("channels:" + room, "salt", salt, callback);
											}, function (callback) {
												redisC.hset("channels:" + room, "password", derivedKey.toString(), callback);
											}
										], function (err, reply) {
											if (err) throw err;
											socket.emit('chat:' + room, serverSentMessage({
												body: "This channel is now private.  Please remember your password."
											}, room));
										});

									});
								});
							} catch (e) {
								socket.emit('chat:' + room, serverSentMessage({
									body: "Error in setting the channel to private: " + e
								}, room));
							}
						} else {
							socket.emit('chat:' + room, serverSentMessage({
								body: "This channel is already private."
							}, room));
						}
					});
				},
				"join_private": function (data) {

					redisC.hget("channels:" + room, "isPrivate", function (err, reply) {
						if (err) throw err;
						if (reply === "true") { // channel is not currently private
							console.log(client.get("nick"), "attempting to auth to private room");
							async.parallel({
								salt: function (callback) {
									redisC.hget("channels:" + room, "salt", callback);
								},
								password: function (callback) {
									redisC.hget("channels:" + room, "password", callback);
								}
							}, function (err, stored) {
								if (err) throw err;
								crypto.pbkdf2(data.password, stored.salt, 4096, 256, function (err, derivedKey) {
									if (err) throw err;

									if (derivedKey.toString() !== stored.password) { // FAIL
										socket.emit('chat:' + room, serverSentMessage({
											body: "Wrong password for room"
										}, room));
										socket.in(room).broadcast.emit('chat:' + room, serverSentMessage({
											body: client.get("nick") + " just failed to join the room."
										}, room));
									} else { // ident'd
										client.set("room", room);
										channel.clients.push(client);
										// officially join the room on the server:
										socket.join(room);

										// do the typical post-join stuff
										subscribeSuccess(socket, client, room);

										socket.emit("subscribed:" + room);
									}
								});
							});
						} else {
							socket.emit('chat:' + room, serverSentMessage({
								body: "This channel isn't private."
							}, room));
						}
					});
				},
				"nickname": function (data) {

					var newName = data.nickname.replace(REGEXES.commands.nick, "").trim(),
						prevName = client.get("nick");
					client.set("identified", false);

					if (newName === "") {
						socket.emit('chat:' + room, serverSentMessage({
							body: "You may not use the empty string as a nickname.",
							log: false
						}, room));
						return;
					}

					client.set("nick", newName);

					socket.broadcast.emit('chat:' + room, serverSentMessage({
						body: prevName + " is now known as " + newName,
						log: false
					}, room));
					socket.emit('chat:' + room, serverSentMessage({
						body: "You are now known as " + newName,
						log: false
					}, room));
					publishUserList(room);
				},
				"topic": function (data) {
					redisC.hset('topic', room, data.topic);
					socket.emit('topic:' + room, serverSentMessage({
						body: data.topic,
						log: false
					}, room));
				},
				"chat:history_request": function (data) {
					console.log("requesting " + data.requestRange);
					redisC.hmget("chatlog:" + room, data.requestRange, function (err, reply) {
						if (err) throw err;
						console.log(reply);
						// emit the logged replies to the client requesting them
						_.each(reply, function (chatMsg) {
							if (chatMsg === null) return;
							socket.emit('chat:' + room, JSON.parse(chatMsg));
						});
					});
				},
				"chat:idle": function (data) {
					console.log("found guy idle");
					client.set("idle", true);
					client.set("idleSince", Number(new Date()));
					data.cID = client.cid;
					sio.of(CHATSPACE).emit('chat:idle:' + room, data);
					publishUserList(room);
				},
				"chat:unidle": function (data) {
					client.set("idle", false);
					client.unset("idleSince");
					sio.of(CHATSPACE).emit('chat:unidle:' + room, {
						cID: client.cid
					});
					publishUserList(room);
				},
				"chat": function (data) {
					if (data.body) {
						data.cID = client.cid;
						data.color = client.get("color").toRGB();
						data.nickname = client.get("nick");
						data.timestamp = Number(new Date());

						// store in redis
						redisC.hget("channels:currentMessageID", room, function (err, reply) {
							if (err) throw err;

							var mID = 0;
							if (reply) {
								mID = parseInt(reply, 10);
							}
							redisC.hset("channels:currentMessageID", room, mID+1);

							data.ID = mID;

							// store the chat message
							redisC.hset("chatlog:" + room, mID, JSON.stringify(data), function (err, reply) {
								if (err) throw err;
							});

							socket.in(room).broadcast.emit('chat:' + room, data);
							socket.in(room).emit('chat:' + room, _.extend(data, {
								you: true
							}));

							if (config.features.phantomjs_screenshot) {
								// strip out other things the client is doing before we attempt to render the web page
								var urls = data.body.replace(REGEXES.urls.image, "")
													.replace(REGEXES.urls.youtube,"")
													.match(REGEXES.urls.all_others);
								if (urls) {
									for (var i = 0; i < urls.length; i++) {
										
										var randomFilename = parseInt(Math.random()*9000,10).toString() + ".jpg";
										
										(function (url, fileName) { // run our screenshotting routine in a self-executing closure so we can keep the current filename & url
											var output = SANDBOXED_FOLDER + "/" + fileName,
												pageData = {};
											
											console.log("Processing ", urls[i]);
											// requires that the phantomjs-screenshot repo is a sibling repo of this one
											var screenshotter = spawn('/opt/bin/phantomjs',
												['../../phantomjs-screenshot/main.js', url, output],
												{
													cwd: __dirname
												});

											screenshotter.stdout.on('data', function (data) {
												console.log('screenshotter stdout: ' + data);
												data = data.toString(); // explicitly cast it, who knows what type it is having come from a process

												// attempt to extract any parameters phantomjs might expose via stdout
												var tmp = data.match(REGEXES.phantomjs.parameter);
												if (tmp && tmp.length) {
													var key = tmp[0].replace(REGEXES.phantomjs.delimiter, "").trim();
													var value = data.replace(REGEXES.phantomjs.parameter, "").trim();
													pageData[key] = value;
												}
											});
											screenshotter.stderr.on('data', function (data) {
												console.log('screenshotter stderr: ' + data);
											});
											screenshotter.on("exit", function (data) {
												console.log('screenshotter exit: ' + data);
												if (pageData.title && pageData.excerpt) {
													sio.of(CHATSPACE).emit('chat:' + room, serverSentMessage({
														body: '<<' + pageData.title + '>>: "'+ pageData.excerpt +'" (' + url + ') ' + urlRoot() + 'sandbox/' + fileName
													}, room));
												} else if (pageData.title) {
													sio.of(CHATSPACE).emit('chat:' + room, serverSentMessage({
														body: '<<' + pageData.title + '>> (' + url + ') ' + urlRoot() + 'sandbox/' + fileName
													}, room));
												} else {
													sio.of(CHATSPACE).emit('chat:' + room, serverSentMessage({
														body: urlRoot() + 'sandbox/' + fileName
													}, room));
												}
											});
										})(urls[i], randomFilename); // call our closure with our random filename
									}
								}
							}
						});
					}
				},
				"identify": function (data) {
					var nick = client.get("nick");
					try {
						redisC.sismember("users:" + room, nick, function (err, reply) {
							if (!reply) {
								socket.emit('chat:' + room, serverSentMessage({
									body: "There's no registration on file for " + nick
								}, room));
							} else {
								async.parallel({
									salt: function (callback) {
										redisC.hget("salts:" + room, nick, callback);
									},
									password: function (callback) {
										redisC.hget("passwords:" + room, nick, callback);
									}
								}, function (err, stored) {
									if (err) throw err;
									crypto.pbkdf2(data.password, stored.salt, 4096, 256, function (err, derivedKey) {
										if (err) throw err;

										if (derivedKey.toString() !== stored.password) { // FAIL
											client.set("identified", false);
											socket.emit('chat:' + room, serverSentMessage({
												body: "Wrong password for " + nick
											}, room));
											socket.in(room).broadcast.emit('chat:' + room, serverSentMessage({
												body: nick + " just failed to identify himself"
											}, room));
											publishUserList(room);
										} else { // ident'd
											client.set("identified", true);
											socket.emit('chat:' + room, serverSentMessage({
												body: "You are now identified for " + nick
											}, room));
											publishUserList(room);
										}
									});
								});
							}
						});
					} catch (e) { // identification error
						socket.emit('chat:' + room, serverSentMessage({
							body: "Error identifying yourself: " + e
						}, room));
					}
				},
				"register_nick": function (data) {
					var nick = client.get("nick");
					redisC.sismember("users:" + room, nick, function (err, reply) {
						if (err) throw err;
						if (!reply) { // nick is not in use
							try { // try crypto & persistence
								crypto.randomBytes(256, function (ex, buf) {
									if (ex) throw ex;
									var salt = buf.toString();
									
									crypto.pbkdf2(data.password, salt, 4096, 256, function (err, derivedKey) {
										if (err) throw err;

										redisC.sadd("users:" + room, nick, function (err, reply) {
											if (err) throw err;
										});
										redisC.hset("salts:" + room, nick, salt, function (err, reply) {
											if (err) throw err;
										});
										redisC.hset("passwords:" + room, nick, derivedKey.toString(), function (err, reply) {
											if (err) throw err;
										});

										client.set("identified", true);
										socket.emit('chat:' + room, serverSentMessage({
											body: "You have registered your nickname.  Please remember your password."
										}, room));
										publishUserList(room);
									});
								});
							} catch (e) {
								socket.emit('chat:' + room, serverSentMessage({
									body: "Error in registering your nickname: " + e
								}, room));
							}
						} else { // nick is already in use
							socket.emit('chat:' + room, serverSentMessage({
								body: "That nickname is already registered by somebody."
							}, room));
						}
					});
				},
				"unsubscribe": function () {
					console.log("unsub'ing ", client.cid, "from", room);

					socket.leave(room);
					// unbind all events
					_.each(chatEvents, function (value, key) {
						socket.removeAllListeners(key + ":" + room);
					});

					userLeft(client, room);

					var channel = channels[room];
					channel.clients.remove(client);
					publishUserList(room);
				}
			};
			// get the channel
			var channel = channels[room];
			if (typeof channel === "undefined") { // start a new channel if it doesn't exist
				channel = new Channel(room);
				channels[room] = channel;
			}

			// check to see if the room is private:
			redisC.hget("channels:" + room, "isPrivate", function (err, reply) {
				if (err) throw err;
				if (reply === "true") { // if it's private
					console.log("user attempted to join private room");
					socket.emit('chat:' + room, serverSentMessage({
						body: "This room is private.  Type /password [room password] to join.",
						log: false
					}, room));
					client = new Client();
					subscribeAck({
						cid: client.cid
					});
				} else { // it's public:
					console.log("subscribed to public room", data.room);

					// add the new client to our internal list
					client = new Client({
						room: room
					});
					channel.clients.push(client);
					// officially join the room on the server:
					socket.join(room);

					// do the typical post-join stuff
					subscribeSuccess(socket, client, room);
					subscribeAck({
						cid: client.cid
					});
				}
			});

			// unauthenticated events:
			var unauthenticatedEvents = ["join_private"];

			// bind all chat events:
			_.each(chatEvents, function (method, eventName) {
				var authFiltered = _.wrap(method, function (meth) {
					console.log(arguments);
					console.log(eventName, client.get("room"), !_.contains(unauthenticatedEvents, eventName));
					if (client.get("room") !== room &&
						!_.contains(unauthenticatedEvents, eventName)) {
						return;
					}
					var args = Array.prototype.slice.call(arguments).splice(1); // first arg is the function itself
					meth.apply(socket, args); // not even once.
				});
				socket.on(eventName + ":" + room, authFiltered);
			});

			socket.on('disconnect', function () {
				console.log("killing ", client.cid);

				userLeft(client, room);

				var channel = channels[room];
				channel.clients.remove(client);
				_.each(chatEvents, function (value, key) {
					socket.removeAllListeners(key + ":" + room);
				});

				publishUserList(room);

			});
		});

	});

}