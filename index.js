var config = require(process.env.HOME + '/.partyplayConfig.js');
//var defaultConfig = require(__dirname + '/partyplayConfigDefaults.js');

var http = require('http');

var fs = require('fs');
var mkdirp = require('mkdirp');
if(!fs.existsSync(config.songCachePath))
    mkdirp.sync(config.songCachePath);

var express = require('express');
var bodyParser = require('body-parser');
var app = express();

var ipfilter = require('express-ipfilter');
var _ = require('underscore');

var _playerState = {
    queue: [],
    nowPlaying: null,
    modules: {},
    backends: {},
    frontends: {}
}

var _callHooks = function(hook, argv) {
    // _.find() used instead of _.each() because we want to break out as soon
    // as a hook returns a truthy value (used to indicate an error, e.g. in form
    // of a string)
    return _.find(_playerState.modules, function(module) {
        if(module[hook]) {
            return module[hook].apply(null, argv);
        }
    });
};

// to be called whenever the queue has been modified
// this function will:
// - play back the first song in the queue if no song is playing
// - prepare first and second songs in the queue
var _onQueueModify = function() {
    if(!_playerState.queue.length) {
        _callHooks('onEndOfQueue', [_playerState]);
        console.log('end of queue, waiting for more songs');
        return;
    }

    var startPlayingNext = false;
    if(!_playerState.nowPlaying) {
        // play song
        _playerState.nowPlaying = _playerState.queue.shift();
        _removeFromQueue(_playerState.nowPlaying.id);
        startPlayingNext = true;


        // TODO: move to partyplay module onSongEnd()
        /*
        for (var i = queue.length - 1; i >= 0; i--) {
            _playerState.queue[i].oldness++;

            // remove bad songs
            var numDownVotes = Object.keys(_playerState.queue[i].downVotes).length;
            var numUpVotes = Object.keys(_playerState.queue[i].upVotes).length;
            var totalVotes = numDownVotes + numUpVotes;
            if(numDownVotes / totalVotes > config.badVotePercent) {
                console.log('song ' + _playerState.queue[i].id + ' removed due to downvotes');
                _removeFromQueue(_playerState.queue[i].id);
            }
        }
        */
    }

    // TODO: error handling if backends[...] is undefined
    // prepare now playing song
    _playerState.backends[_playerState.nowPlaying.backend].prepareSong(_playerState.nowPlaying.id, function() {
        _callHooks('onSongPrepared', [_playerState]);

        if(startPlayingNext) {
            console.log('playing song: ' + _playerState.nowPlaying.id);

            // TODO: socket.io frontend
            /*
            io.emit('playback', {
                songID: _playerState.nowPlaying.id,
                format: _playerState.nowPlaying.format,
                backend: _playerState.nowPlaying.backend,
                duration: _playerState.nowPlaying.duration
            });
            */
            _playerState.nowPlaying.playbackStart = new Date();

            _callHooks('onSongChange', [_playerState]);

            var songTimeout = parseInt(_playerState.nowPlaying.duration) + config.songDelayMs;
            setTimeout(function() {
                console.log('end of song ' + _playerState.nowPlaying.id);
                _callHooks('onSongEnd', [_playerState]);

                _playerState.nowPlaying = null;
                _onQueueModify();
                // TODO: socket.io frontend
                //io.emit('queue', [_playerState.nowPlaying, _playerState.queue]);
            }, songTimeout);
        }

        // TODO: support pre-caching multiple songs at once if configured so
        // prepare next song(s) in queue
        if(_playerState.queue.length) {
            _playerState.backends[_playerState.queue[0].backend].prepareSong(_playerState.queue[0].id, function() {
                _callHooks('onNextSongPrepared', [_playerState, 0]);
                // do nothing
            }, function(err) {
                console.log('error! removing song from queue ' + _playerState.queue[0].id);
                _callHooks('onNextSongPrepareError', [_playerState, 0]);
                _removeFromQueue(_playerState.queue[0].id);
                // TODO: socket.io frontend
                //io.emit('queue', [_playerState.nowPlaying, _playerState.queue]);
            });
        } else {
            console.log('no songs in queue to prepare');
            _callHooks('onNothingToPrepare', [_playerState]);
        }
    }, function(err) {
        console.log('error! removing song from queue ' + _playerState.nowPlaying.id);
        _callHooks('onSongPrepareError', [_playerState]);
        _removeFromQueue(_playerState.nowPlaying.id);
        // TODO: socket.io frontend
        //io.emit('queue', [_playerState.nowPlaying, _playerState.queue]);
    });
};

// TODO: partyplay sortQueue() hook
// sort queue according to votes and oldness
/*
var sortQueue = function() {
    _playerState.queue.sort(function(a, b) {
        return ((b.oldness + Object.keys(b.upVotes).length - Object.keys(b.downVotes).length) -
               (a.oldness + Object.keys(a.upVotes).length - Object.keys(a.downVotes).length));
    });
};
*/

// find song from queue
var _searchQueue = function(songID) {
    for(var i = 0; i < _playerState.queue.length; i++) {
        if(_playerState.queue[i].id === songID)
            return _playerState.queue[i];
    }

    if(_playerState.nowPlaying && _playerState.nowPlaying.id === songID)
        return _playerState.nowPlaying;

    return null;
};

// get rid of song in queue
var _removeFromQueue = function(songID) {
    for(var i = 0; i < _playerState.queue.length; i++) {
        if(_playerState.queue[i].id === songID) {
            _playerState.queue.splice(i, 1);
            return;
        }
    }
};

// initialize song object
var _initializeSong = function(song) {
    song.upVotes = {};
    song.downVotes = {};
    song.oldness = 0; // favor old songs
    song.playbackStart = null;

    _playerState.queue.push(song);
    return song;
};

var _addToQueue = function(song) {
    // check that required fields are provided
    if(!song.title || !song.id || !song.duration) {
        return 'required song fields not provided';
    }

    // check that user has an id
    var userID = req.body.userID;
    if(!userID) {
        return 'invalid userID';
    }

    // if same song is already queued, don't create a duplicate
    var queuedSong = _searchQueue(song.id);
    if(queuedSong) {
        console.log('not adding duplicate song to queue: ' + queuedSong.id);
        return 'duplicate songID';
    }

    var err = _callHooks('preSongQueued', [_playerState, song]);
    if(err)
        return err;

    // no duplicate found, initialize a few properties of song
    queuedSong = _initializeSong(song);

    // TODO: partyplay onSongQueued()
    /*
    // new song automatically gets upvote by whoever added it
    voteSong(queuedSong, +1, userID);
    */

    _onQueueModify();

    console.log('added song to queue: ' + queuedSong.id);
    _callHooks('postSongQueued', [_playerState, queuedSong]);
    // TODO socket.io frontend
    //io.emit('queue', [_playerState.nowPlaying, _playerState.queue]);
};

// TODO: move to partyplay module
/*
var voteSong = function(song, vote, userID) {
    // normalize vote to -1, 0, 1
    vote = parseInt(vote);

    if(vote)
        vote = vote / Math.abs(vote);
    else
        vote = 0;

    if(!vote) {
        delete(song.upVotes[userID]);
        delete(song.downVotes[userID]);
    } else if (vote > 0) {
        delete(song.downVotes[userID]);
        song.upVotes[userID] = true;
    } else if (vote < 0) {
        delete(song.upVotes[userID]);
        song.downVotes[userID] = true;
    }

    _callHooks('sortQueue');
};

app.post('/vote/:id', bodyParser.json(), function(req, res) {
    var userID = req.body.userID;
    var vote = req.body.vote;
    var songID = req.params.id;
    if(!userID || vote === undefined || !songID) {
        res.status(404).send('please provide both userID and vote in the body');
    }

    var queuedSong = _searchQueue(songID);
    if(!queuedSong) {
        res.status(404).send('song not found');
    }

    voteSong(queuedSong, vote, userID);
    _onQueueModify();
    io.emit('queue', [_playerState.nowPlaying, _playerState.queue]);

    console.log('got vote ' + vote + ' for song: ' + queuedSong.id);

    res.send('success');
});
*/

// TODO: move to REST API frontend
// get entire queue
/*
app.get('/queue', function(req, res) {
    var response = [];
    if(_playerState.nowPlaying) {
        response.push({
            artist: _playerState.nowPlaying.artist,
            title: _playerState.nowPlaying.title,
            duration: _playerState.nowPlaying.duration,
            id: _playerState.nowPlaying.id,
            downVotes: _playerState.nowPlaying.downVotes,
            upVotes: _playerState.nowPlaying.upVotes,
            oldness: _playerState.nowPlaying.oldness
        });
    }
    for(var i = 0; i < _playerState.queue.length; i++) {
        response.push({
            artist: _playerState.queue[i].artist,
            title: _playerState.queue[i].title,
            duration: _playerState.queue[i].duration,
            id: _playerState.queue[i].id,
            downVotes: _playerState.queue[i].downVotes,
            upVotes: _playerState.queue[i].upVotes,
            oldness: _playerState.queue[i].oldness
        });
    }
    res.send(JSON.stringify(response));
});

// queue song
app.post('/queue', bodyParser.json(), function(req, res) {
    var err = _addToQueue(req.body.song);
    if(err)
        res.status(404).send(err);
    else
        res.send('success');
});

// search for song with given search terms
app.get('/search/:terms', function(req, res) {
    console.log('got search request: ' + req.params.terms);

    var resultCnt = 0;
    var results = [];

    for(var backend in _playerState.backends) {
        (function(backend) {
            _playerState.backends[backend].search(req.params.terms, function(songs) {
                resultCnt++;

                for(song in songs) {
                    results.push(songs[song]);
                }

                // got results from all services?
                if(resultCnt >= Object.keys(_playerState.backends).length)
                    res.send(JSON.stringify(results));
            }, function(err) {
                resultCnt++;
                console.log(err);

                // got results from all services?
                if(resultCnt >= Object.keys(_playerState.backends).length)
                    res.send(JSON.stringify(results));
            });
        })(backend);
    }
});

var checkIP = ipfilter(config.filterStreamIPs, {mode: config.filterAction, log: config.log, cidr: true});
app.use('/song', checkIP);
app.use(express.static(__dirname + '/public'));
*/

// TODO: socket.io frontend
/*
var server = app.listen(process.env.PORT || 8080);
var io = require('socket.io')(server);
io.on('connection', function(socket) {
    if(_playerState.nowPlaying) {
        socket.emit('playback', {
            songID: _playerState.nowPlaying.id,
            format: _playerState.nowPlaying.format,
            backend: _playerState.nowPlaying.backend,
            duration: _playerState.nowPlaying.duration,
            position: new Date() - _playerState.nowPlaying.playbackStart
        });
    }
    socket.emit('queue', [_playerState.nowPlaying, _playerState.queue]);
});

console.log('listening on port ' + (process.env.PORT || 8080));
*/

// init backends
_.each(config.backendServices, function(backendName) {
    // TODO: put backend modules into npm
    var backend = require('./backends/' + backendName);

    backend.init(config, function() {
        _playerState.backends[backendName] = {};
        _playerState.backends[backendName].prepareSong = backend.prepareSong;
        _playerState.backends[backendName].search = backend.search;

        console.log('backend ' + backendName + ' initialized');
        _callHooks('onBackendInit', [_playerState, backendName]);

        // TODO: move to REST API frontend
        //app.use('/song/' + backendName, backend.middleware);
    }, function(err) {
        console.log('error ' + err + ' while initializing ' +  backendName);
        _callHooks('onBackendInitError', [_playerState, backendName]);
    });
});
