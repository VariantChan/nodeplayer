'use strict';

var path = require('path');
var fs = require('fs');
var mkdirp = require('mkdirp');
var mongoose = require('mongoose');
var async = require('async');
var walk = require('walk');
var ffprobe = require('node-ffprobe');
var _ = require('lodash');
var escapeStringRegexp = require('escape-string-regexp');

var util = require('util');
var Backend = require('../backend');

// external libraries use lower_case extensively here
// jscs:disable requireCamelCaseOrUpperCaseIdentifiers

/*
var probeCallback = (err, probeData, next) => {
    var formats = config.importFormats;
    if (probeData) {
        // ignore camel case rule here as we can't do anything about probeData
        //jscs:disable requireCamelCaseOrUpperCaseIdentifiers
        if (formats.indexOf(probeData.format.format_name) >= 0) { // Format is supported
            //jscs:enable requireCamelCaseOrUpperCaseIdentifiers
            var song = {
                title: '',
                artist: '',
                album: '',
                duration: '0',
            };

            // some tags may be in mixed/all caps, let's convert every tag to lower case
            var key;
            var keys = Object.keys(probeData.metadata);
            var n = keys.length;
            var metadata = {};
            while (n--) {
                key = keys[n];
                metadata[key.toLowerCase()] = probeData.metadata[key];
            }

            // try a best guess based on filename in case tags are unavailable
            var basename = path.basename(probeData.file);
            basename = path.basename(probeData.file, path.extname(basename));
            var splitTitle = basename.split(/\s-\s(.+)?/);

            if (!_.isUndefined(metadata.title)) {
                song.title = metadata.title;
            } else {
                song.title = splitTitle[1];
            }
            if (!_.isUndefined(metadata.artist)) {
                song.artist = metadata.artist;
            } else {
                song.artist = splitTitle[0];
            }
            if (!_.isUndefined(metadata.album)) {
                song.album = metadata.album;
            }

            song.file = probeData.file;

            song.duration = probeData.format.duration * 1000;
            SongModel.update({file: probeData.file}, {'$set':song}, {upsert: true},
                    (err, result) => {
                if (result == 1) {
                    self.log.debug('Upserted: ' + probeData.file);
                } else {
                    self.log.error('error while updating db: ' + err);
                }

                next();
            });
        } else {
            self.log.verbose('format not supported, skipping...');
            next();
        }
    } else {
        self.log.error('error while probing:' + err);
        next();
    }
};
*/

// database model
var SongModel = mongoose.model('Song', {
  title: String,
  artist: String,
  album: String,
  albumArt: {
    lq: String,
    hq: String,
  },
  duration: {
    type: Number,
    required: true,
  },
  format: {
    type: String,
    required: true,
  },
  filename: {
    type: String,
    unique: true,
    required: true,
    dropDups: true,
  },
});

/**
 * Try to guess metadata from file path,
 * Assumes the following naming conventions:
 * /path/to/music/Album/Artist - Title.ext
 *
 * @param {String} filePath - Full file path including filename extension
 * @param {String} fileExt - Filename extension
 * @return {Metadata} Song metadata
 */
var guessMetadataFromPath = (filePath, fileExt) => {
  var fileName = path.basename(filePath, fileExt);

  // split filename at dashes, trim extra whitespace, e.g:
  var splitName = fileName.split('-');
  splitName = _.map(splitName, (name) => {
    return name.trim();
  });

  // TODO: compare album name against music dir, leave empty if equal
  return {
    artist: splitName[0],
    title: splitName[1],
    album: path.basename(path.dirname(filePath)),
  };
};

function Local(callback) {
  Backend.apply(this);

  var self = this;

    // NOTE: no argument passed so we get the core's config
  var config = require('../config').getConfig();
  this.config = config;
  this.songCachePath = config.songCachePath;
  this.importFormats = config.importFormats;

    // make sure all necessary directories exist
  mkdirp.sync(path.join(this.songCachePath, 'local', 'incomplete'));

    // connect to the database
  mongoose.connect(config.mongo);

  var db = mongoose.connection;
  db.on('error', (err) => {
    return callback(err, self);
  });
  db.once('open', () => {
    return callback(null, self);
  });

  var options = {
    followLinks: config.followSymlinks,
  };

  var insertSong = (probeData, done) => {
    var guessMetadata = guessMetadataFromPath(probeData.file, probeData.fileext);

    var song = new SongModel({
      title: probeData.metadata.TITLE || guessMetadata.title,
      artist: probeData.metadata.ARTIST || guessMetadata.artist,
      album: probeData.metadata.ALBUM || guessMetadata.album,
            // albumArt: {} // TODO
      duration: probeData.format.duration * 1000,
      format: probeData.format.format_name,
      filename: probeData.file,
    });

    song = song.toObject();

    delete song._id;

    SongModel.findOneAndUpdate({
      filename: probeData.file,
    }, song, { upsert: true }, (err) => {
      if (err) {
        self.log.error('while inserting song: ' + probeData.file + ', ' + err);
      }
      done();
    });
  };

    // create async.js queue to limit concurrent probes
  var q = async.queue((task, done) => {
    ffprobe(task.filename, (err, probeData) => {
      if (!probeData) {
        return done();
      }

      var validStreams = false;

      if (_.includes(self.importFormats, probeData.format.format_name)) {
        validStreams = true;
      }

      if (validStreams) {
        insertSong(probeData, done);
      } else {
        self.log.info('skipping file of unknown format: ' + task.filename);
        done();
      }
    });
  }, config.concurrentProbes);

    // walk the filesystem and scan files
    // TODO: also check through entire DB to see that all files still exist on the filesystem
    // TODO: filter by allowed filename extensions
  if (config.rescanAtStart) {
    self.log.info('Scanning directory: ' + config.importPath);
    var walker = walk.walk(config.importPath, options);
    var startTime = new Date();
    var scanned = 0;
    walker.on('file', (root, fileStats, next) => {
      var filename = path.join(root, fileStats.name);
      self.log.verbose('Scanning: ' + filename);
      scanned++;
      q.push({
        filename: filename,
      });
      next();
    });
    walker.on('end', () => {
      self.log.verbose('Scanned files: ' + scanned);
      self.log.verbose('Done in: ' +
                    Math.round((new Date() - startTime) / 1000) + ' seconds');
    });
  }

    // TODO: fs watch
    // set fs watcher on media directory
    // TODO: add a debounce so if the file keeps changing we don't probe it multiple times
    /*
    watch(config.importPath, {
        recursive: true,
        followSymlinks: config.followSymlinks
    }, (filename) => {
        if (fs.existsSync(filename)) {
            self.log.debug(filename + ' modified or created, queued for probing');
            q.unshift({
                filename: filename
            });
        } else {
            self.log.debug(filename + ' deleted');
            db.collection('songs').remove({file: filename}, (err, items) => {
                self.log.debug(filename + ' deleted from db: ' + err + ', ' + items);
            });
        }
    });
    */
}

// must be called immediately after constructor
util.inherits(Local, Backend);

Local.prototype.isPrepared = (song) => {
  var filePath = path.join(this.songCachePath, 'local', song.songId + '.opus');
  return fs.existsSync(filePath);
};

Local.prototype.getDuration = (song, callback) => {
  SongModel.findById(song.songId, (err, item) => {
    if (err) {
      return callback(err);
    }

    callback(null, item.duration);
  });
};

Local.prototype.prepare = (song, callback) => {
  var self = this;

  // TODO: move most of this into common code inside core
  if (self.songsPreparing[song.songId]) {
        // song is preparing, caller can drop this request (previous caller will take care of
        // handling once preparation is finished)
    callback(null, null, false);
  } else if (self.isPrepared(song)) {
        // song has already prepared, caller can start playing song
    callback(null, null, true);
  } else {
        // begin preparing song
    var cancelEncode = null;
    var canceled = false;

    song.prepare = {
      data: new Buffer.allocUnsafe(1024 * 1024),
      dataPos: 0,
      cancel: () => {
        canceled = true;
        if (cancelEncode) {
          cancelEncode();
        }
      },
    };

    self.songsPreparing[song.songId] = song;

    SongModel.findById(song.songId, (err, item) => {
      if (canceled) {
        callback(new Error('song was canceled before encoding started'));
      } else if (item) {
        var readStream = fs.createReadStream(item.filename);
        cancelEncode = self.encodeSong(readStream, 0, song, callback);
        readStream.on('error', (err) => {
          callback(err);
        });
      } else {
        callback(new Error('song not found in local db: ' + song.songId));
      }
    });
  }
};

Local.prototype.search = (query, callback) => {
  var self = this;

  var q;
  if (query.any) {
    q = {
      $or: [
                { artist: new RegExp(escapeStringRegexp(query.any), 'i') },
                { title: new RegExp(escapeStringRegexp(query.any), 'i') },
                { album: new RegExp(escapeStringRegexp(query.any), 'i') },
      ],
    };
  } else {
    q = {
      $and: [],
    };

    _.keys(query).forEach((key) => {
      var criterion = {};
      criterion[key] = new RegExp(escapeStringRegexp(query[key]), 'i');
      q.$and.push(criterion);
    });
  }

  SongModel.find(q).exec((err, items) => {
    if (err) {
      return callback(err);
    }

    var results = {};
    results.songs = {};

    var numItems = items.length;
    var cur = 0;
    items.forEach((song) => {
      if (Object.keys(results.songs).length <= self.config.searchResultCnt) {
        song = song.toObject();

        results.songs[song._id] = {
          artist: song.artist,
          title: song.title,
          album: song.album,
          albumArt: null, // TODO: can we add this?
          duration: song.duration,
          songId: song._id,
          score: self.config.maxScore * (numItems - cur) / numItems,
          backendName: 'local',
          format: 'opus',
        };
        cur++;
      }
    });
    callback(results);
  });
};

module.exports = Local;