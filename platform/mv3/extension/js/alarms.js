/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2026-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

import {
    browser,
    localRead, localRemove, localWrite,
} from './ext.js';

import { ubolLog } from './debug.js';

/******************************************************************************/

let pendingJobsMutation = Promise.resolve();
const runningJobNames = new Set();
const JOB_RETRY_DELAY = 5 * 60 * 1000;
let jobRunSequence = 0;

function enqueueJobsMutation(task) {
    const result = pendingJobsMutation.then(task);
    pendingJobsMutation = result.catch(( ) => { });
    return result;
}

function newJobRunToken(now) {
    if ( typeof globalThis.crypto?.randomUUID === 'function' ) {
        return globalThis.crypto.randomUUID();
    }
    jobRunSequence += 1;
    return `${now.toString(36)}-${jobRunSequence.toString(36)}`;
}

/******************************************************************************/

function setupJobsAlarm(jobs) {
    if ( Boolean(jobs?.length) === false ) {
        return browser.alarms.clear('deferredJobs');
    }
    // No less than 5 minutes in the future
    const when = Math.max(jobs[0].time, Date.now() + JOB_RETRY_DELAY);
    ubolLog(`Created alarm for ${(new Date(when)).toString()}`);
    return browser.alarms.create('deferredJobs', { when });
}

export function registerJob(name, time) {
    return enqueueJobsMutation(async ( ) => {
        const jobs = await localRead('deferredJobs') || [];
        const job = jobs.find(a => a.name === name);
        if ( job ) {
            job.time = time;
            // A handler may deliberately reschedule itself while its previous
            // run is still completing. In that case, completion of the old
            // run must not remove the new schedule.
            delete job.runToken;
        } else {
            jobs.push({ name, time });
        }
        jobs.sort((a, b) => a.time - b.time);
        await localWrite('deferredJobs', jobs);
        return setupJobsAlarm(jobs);
    });
}

export function removeJob(name) {
    return enqueueJobsMutation(async ( ) => {
        const before = await localRead('deferredJobs') || [];
        const after = before.filter(a => a.name !== name);
        if ( after.length === before.length ) { return; }
        if ( after.length ) {
            await localWrite('deferredJobs', after);
        } else {
            await localRemove('deferredJobs');
        }
        return setupJobsAlarm(after);
    });
}

export async function processDueJobs(dispatcher) {
    const toProcess = await enqueueJobsMutation(async ( ) => {
        const jobs = await localRead('deferredJobs') || [];
        if ( Boolean(jobs?.length) === false ) { return []; }
        const now = Date.now();
        const due = [];
        for ( const job of jobs ) {
            if ( job.time > now || runningJobNames.has(job.name) ) { continue; }
            job.time = now + JOB_RETRY_DELAY;
            job.runToken = newJobRunToken(now);
            due.push({ ...job });
        }
        jobs.sort((a, b) => a.time - b.time);
        await localWrite('deferredJobs', jobs);
        await setupJobsAlarm(jobs);
        due.forEach(job => runningJobNames.add(job.name));
        return due;
    });
    if ( toProcess.length === 0 ) { return; }

    const results = await Promise.allSettled(toProcess.map(job =>
        Promise.resolve().then(( ) => dispatcher({ what: job.name }))
    ));
    const completed = new Map();
    for ( let i = 0; i < results.length; i++ ) {
        if ( results[i].status !== 'fulfilled' ) { continue; }
        completed.set(toProcess[i].name, toProcess[i].runToken);
    }

    try {
        if ( completed.size !== 0 ) {
            await enqueueJobsMutation(async ( ) => {
                const before = await localRead('deferredJobs') || [];
                const after = before.filter(job =>
                    completed.has(job.name) === false ||
                    completed.get(job.name) !== job.runToken
                );
                if ( after.length ) {
                    await localWrite('deferredJobs', after);
                } else {
                    await localRemove('deferredJobs');
                }
                await setupJobsAlarm(after);
            });
        }
    } finally {
        toProcess.forEach(job => runningJobNames.delete(job.name));
    }

    const rejected = results.find(result => result.status === 'rejected');
    if ( rejected ) { throw rejected.reason; }
}

export function resetJobsAlarm() {
    return enqueueJobsMutation(async ( ) => {
        const jobs = await localRead('deferredJobs');
        return setupJobsAlarm(jobs);
    });
}
