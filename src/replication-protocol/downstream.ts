import {
    firstValueFrom,
    filter
} from 'rxjs';
import { stackCheckpoints } from '../rx-storage-helper';
import type {
    RxStorageInstanceReplicationState,
    BulkWriteRow,
    BulkWriteRowById,
    RxStorageReplicationMeta,
    RxDocumentData,
    ById,
    WithDeleted,
    DocumentsWithCheckpoint
} from '../types';
import {
    createRevision,
    ensureNotFalsy,
    flatClone,
    getDefaultRevision,
    getDefaultRxDocumentMeta,
    now,
    parseRevision,
    PROMISE_RESOLVE_FALSE,
    PROMISE_RESOLVE_VOID
} from '../util';
import {
    getLastCheckpointDoc,
    setCheckpoint
} from './checkpoint';
import { writeDocToDocState } from './helper';
import {
    getAssumedMasterState,
    getMetaWriteRow
} from './meta-instance';

/**
 * Writes all documents from the master to the fork.
 * The downstream has two operation modes
 * - Sync by iterating over the checkpoints via downstreamResyncOnce()
 * - Sync by listening to the changestream via downstreamProcessChanges()
 * We need this to be able to do initial syncs
 * and still can have fast event based sync when the client is not offline.
 */
export function startReplicationDownstream<RxDocType, CheckpointType = any>(
    state: RxStorageInstanceReplicationState<RxDocType>
) {
    const replicationHandler = state.input.replicationHandler;

    // used to detect which tasks etc can in it at which order.
    let timer = 0;


    type Task = DocumentsWithCheckpoint<RxDocType, any> | 'RESYNC';
    type TaskWithTime = {
        time: number;
        task: Task;
    };
    const openTasks: TaskWithTime[] = [];


    function addNewTask(task: Task): void {
        state.stats.down.addNewTask = state.stats.down.addNewTask + 1;
        const taskWithTime = {
            time: timer++,
            task
        };
        openTasks.push(taskWithTime);
        state.streamQueue.down = state.streamQueue.down
            .then(() => {
                const useTasks: Task[] = [];
                while (openTasks.length > 0) {
                    state.events.active.down.next(true);
                    const taskWithTime = ensureNotFalsy(openTasks.shift());

                    /**
                     * If the task came in before the last time we started the pull 
                     * from the master, then we can drop the task.
                     */
                    if (taskWithTime.time < lastTimeMasterChangesRequested) {
                        continue;
                    }

                    if (taskWithTime.task === 'RESYNC') {
                        if (useTasks.length === 0) {
                            useTasks.push(taskWithTime.task);
                            break;
                        } else {
                            break;
                        }
                    }

                    useTasks.push(taskWithTime.task);
                }

                if (useTasks.length === 0) {
                    state.events.active.down.next(false);
                    return;
                }

                if (useTasks[0] === 'RESYNC') {
                    return downstreamResyncOnce();
                } else {
                    return downstreamProcessChanges(useTasks);
                }
            });
    }
    addNewTask('RESYNC');

    /**
     * If a write on the master happens, we have to trigger the downstream.
     */
    const sub = replicationHandler
        .masterChangeStream$
        .subscribe((task: Task) => {
            state.stats.down.masterChangeStreamEmit = state.stats.down.masterChangeStreamEmit + 1;
            addNewTask(task);
        });
    firstValueFrom(
        state.events.canceled.pipe(
            filter(canceled => !!canceled)
        )
    ).then(() => sub.unsubscribe());


    /**
     * For faster performance, we directly start each write
     * and then await all writes at the end.
     */
    let lastTimeMasterChangesRequested: number = -1;
    async function downstreamResyncOnce() {
        state.stats.down.downstreamResyncOnce = state.stats.down.downstreamResyncOnce + 1;
        if (state.events.canceled.getValue()) {
            return;
        }

        state.checkpointQueue = state.checkpointQueue.then(() => getLastCheckpointDoc(state, 'down'));
        let lastCheckpoint: CheckpointType = await state.checkpointQueue;


        const promises: Promise<any>[] = [];
        while (!state.events.canceled.getValue()) {
            console.log('lastCheckpointlastCheckpointlastCheckpointlastCheckpoint:');
            console.dir(lastCheckpoint);
            lastTimeMasterChangesRequested = timer++;
            const downResult = await replicationHandler.masterChangesSince(
                lastCheckpoint,
                state.input.pullBatchSize
            );


            console.log(':::: DOWN RESULT:');
            console.dir(downResult);

            if (downResult.documents.length === 0) {
                break;
            }

            lastCheckpoint = stackCheckpoints([lastCheckpoint, downResult.checkpoint]);

            console.log('lastCheckpoint:');
            console.dir(lastCheckpoint);

            promises.push(
                persistFromMaster(
                    downResult.documents,
                    lastCheckpoint
                )
            );

            /**
             * By definition we stop pull when the pulled documents
             * do not fill up the pullBatchSize because we
             * can assume that the remote has no more documents.
             */
            if (downResult.documents.length < state.input.pullBatchSize) {
                break;
            }

        }
        return Promise.all(promises)
            .then(() => {
                if (!state.firstSyncDone.down.getValue()) {
                    state.firstSyncDone.down.next(true);
                }
            });
    }


    function downstreamProcessChanges(tasks: Task[]) {
        state.stats.down.downstreamProcessChanges = state.stats.down.downstreamProcessChanges + 1;
        let docsOfAllTasks: WithDeleted<RxDocType>[] = [];
        let lastCheckpoint: CheckpointType | undefined = null as any;

        tasks.forEach(task => {
            if (task === 'RESYNC') {
                throw new Error('SNH');
            }
            docsOfAllTasks = docsOfAllTasks.concat(task.documents);
            lastCheckpoint = stackCheckpoints([lastCheckpoint, task.checkpoint]);
        });
        return persistFromMaster(
            docsOfAllTasks,
            ensureNotFalsy(lastCheckpoint)
        );
    }


    /**
     * It can happen that the calls to masterChangesSince() or the changeStream()
     * are way faster then how fast the documents can be persisted.
     * Therefore we merge all incoming downResults into the nonPersistedFromMaster object
     * and process them together if possible.
     * This often bundles up single writes and improves performance
     * by processing the documents in bulks.
     */
    let persistenceQueue = PROMISE_RESOLVE_VOID;
    const nonPersistedFromMaster: {
        checkpoint?: CheckpointType;
        docs: ById<WithDeleted<RxDocType>>;
    } = {
        docs: {}
    };

    function persistFromMaster(
        docs: WithDeleted<RxDocType>[],
        checkpoint: CheckpointType
    ): Promise<void> {
        state.stats.down.persistFromMaster = state.stats.down.persistFromMaster + 1;

        /**
         * Add the new docs to the non-persistend list
         */
        docs.forEach(docData => {
            const docId: string = (docData as any)[state.primaryPath];
            nonPersistedFromMaster.docs[docId] = docData;
        });
        nonPersistedFromMaster.checkpoint = checkpoint;



        console.log('## persistFromMaster()');
        console.dir(checkpoint);

        /**
         * Run in the queue
         * with all open documents from nonPersistedFromMaster.
         */
        persistenceQueue = persistenceQueue.then(() => {
            const downDocsById: ById<WithDeleted<RxDocType>> = nonPersistedFromMaster.docs;
            nonPersistedFromMaster.docs = {};
            const useCheckpoint = nonPersistedFromMaster.checkpoint;
            const docIds = Object.keys(downDocsById);

            if (
                state.events.canceled.getValue() ||
                docIds.length === 0
            ) {
                return PROMISE_RESOLVE_VOID;
            }

            const writeRowsToFork: BulkWriteRow<RxDocType>[] = [];
            const writeRowsToForkById: ById<BulkWriteRow<RxDocType>> = {};
            const writeRowsToMeta: BulkWriteRowById<RxStorageReplicationMeta> = {};
            const useMetaWriteRows: BulkWriteRow<RxStorageReplicationMeta>[] = [];

            return Promise.all([
                state.input.forkInstance.findDocumentsById(docIds, true),
                getAssumedMasterState(
                    state,
                    docIds
                )
            ]).then(([
                currentForkState,
                assumedMasterState
            ]) => {
                return Promise.all(
                    docIds.map(async (docId) => {
                        console.log('DOWN docId: ' + docId);

                        const forkStateFullDoc: RxDocumentData<RxDocType> | undefined = currentForkState[docId];
                        const forkStateDocData: WithDeleted<RxDocType> | undefined = forkStateFullDoc ? writeDocToDocState(forkStateFullDoc) : undefined;
                        const masterState = downDocsById[docId];
                        const assumedMaster = assumedMasterState[docId];

                        if (
                            assumedMaster &&
                            assumedMaster.metaDocument.isResolvedConflict === forkStateFullDoc._rev
                        ) {
                            /**
                             * The current fork state represents a resolved conflict
                             * that first must be send to the master in the upstream.
                             * All conflicts are resolved by the upstream.
                             */
                            return PROMISE_RESOLVE_VOID;
                        }

                        console.dir({ assumedMaster, forkStateFullDoc });

                        const isAssumedMasterEqualToForkStatePromise = !assumedMaster || !forkStateDocData ?
                            PROMISE_RESOLVE_FALSE :
                            state.input.conflictHandler({
                                realMasterState: assumedMaster.docData,
                                newDocumentState: forkStateDocData
                            }, 'downstream-check-if-equal-0').then(r => r.isEqual);
                        let isAssumedMasterEqualToForkState = await isAssumedMasterEqualToForkStatePromise;

                        if (
                            !isAssumedMasterEqualToForkState &&
                            (
                                assumedMaster &&
                                (assumedMaster.docData as any)._rev &&
                                forkStateFullDoc._meta[state.input.identifier] &&
                                parseRevision(forkStateFullDoc._rev).height === forkStateFullDoc._meta[state.input.identifier]
                            )
                        ) {
                            isAssumedMasterEqualToForkState = true;
                        }

                        console.log('isAssumedMasterEqualToForkState(' + docId + '): ' + isAssumedMasterEqualToForkState);
                        if (
                            (
                                forkStateFullDoc &&
                                assumedMaster &&
                                isAssumedMasterEqualToForkState === false
                            ) ||
                            (
                                forkStateFullDoc && !assumedMaster
                            )
                        ) {
                            /**
                             * We have a non-upstream-replicated
                             * local write to the fork.
                             * This means we ignore the downstream of this document
                             * because anyway the upstream will first resolve the conflict.
                             */
                            console.log('INGORE DOWNSREAM BECAUSE FIRS THAVE TO UP ' + docId);
                            return PROMISE_RESOLVE_VOID;
                        }


                        const areStatesExactlyEqualPromise = !forkStateDocData ?
                            PROMISE_RESOLVE_FALSE :
                            state.input.conflictHandler({
                                realMasterState: masterState,
                                newDocumentState: forkStateDocData
                            }, 'downstream-check-if-equal-1').then(r => r.isEqual);
                        const areStatesExactlyEqual = await areStatesExactlyEqualPromise;

                        console.log('areStatesExactlyEqual(' + docId + '): ' + areStatesExactlyEqual);

                        if (
                            forkStateDocData &&
                            areStatesExactlyEqual
                        ) {
                            /**
                             * Document states are exactly equal.
                             * This can happen when the replication is shut down
                             * unexpected like when the user goes offline.
                             * 
                             * Only when the assumedMaster is different from the forkState,
                             * we have to patch the document in the meta instance.
                             */
                            if (
                                !assumedMaster ||
                                isAssumedMasterEqualToForkState === false
                            ) {
                                useMetaWriteRows.push(
                                    getMetaWriteRow(
                                        state,
                                        forkStateDocData,
                                        assumedMaster ? assumedMaster.metaDocument : undefined
                                    )
                                );
                            }
                            return PROMISE_RESOLVE_VOID;
                        }

                        /**
                         * All other master states need to be written to the forkInstance
                         * and metaInstance.
                         */
                        const newForkState = Object.assign(
                            {},
                            masterState,
                            forkStateFullDoc ? {
                                _meta: flatClone(forkStateFullDoc._meta),
                                _attachments: {},
                                _rev: getDefaultRevision()
                            } : {
                                _meta: getDefaultRxDocumentMeta(),
                                _rev: getDefaultRevision(),
                                _attachments: {}
                            });


                        /**
                         * TODO for unknown reason we need
                         * to manually set the lwt and the _rev here
                         * to fix the pouchdb tests. This is not required for
                         * the other RxStorage implementations which means something is wrong.
                         */
                        newForkState._meta.lwt = now();
                        newForkState._rev = (masterState as any)._rev ? (masterState as any)._rev : createRevision(
                            state.input.hashFunction,
                            newForkState,
                            forkStateFullDoc
                        );

                        /**
                         * If the remote works with revisions,
                         * we store the height of the next fork-state revision
                         * inside of the documents meta data.
                         * By doing so we can filter it out in the upstream
                         * and detect the document as being equal to master or not.
                         * This is used for example in the CouchDB replication plugin.
                         */
                        if ((masterState as any)._rev) {
                            const nextRevisionHeight = !forkStateFullDoc ? 1 : parseRevision(forkStateFullDoc._rev).height + 1;
                            newForkState._meta[state.input.identifier] = nextRevisionHeight;
                        }

                        const forkWriteRow = {
                            previous: forkStateFullDoc,
                            document: newForkState
                        };

                        console.log('forkWriteRow: ' + docId);
                        console.dir(forkWriteRow);

                        writeRowsToFork.push(forkWriteRow);
                        writeRowsToForkById[docId] = forkWriteRow;
                        writeRowsToMeta[docId] = getMetaWriteRow(
                            state,
                            masterState,
                            assumedMaster ? assumedMaster.metaDocument : undefined
                        );
                    })
                );
            }).then(() => {
                console.log('ZZZZZZZZZZZZZZZZZZZZZZWEEEEIIII');
                if (writeRowsToFork.length > 0) {
                    console.log('ZZZZZZZZZZZZZZZZZZZZZZWEEEEIIII 0.1');
                    return state.input.forkInstance.bulkWrite(
                        writeRowsToFork,
                        state.downstreamBulkWriteFlag
                    ).then((forkWriteResult) => {
                        console.log('ZZZZZZZZZZZZZZZZZZZZZZWEEEEIIII   - 2');
                        Object.keys(forkWriteResult.success).forEach((docId) => {
                            state.events.processed.down.next(writeRowsToForkById[docId]);
                            useMetaWriteRows.push(writeRowsToMeta[docId]);
                        });
                    });
                }
                console.log('ZZZZZZZZZZZZZZZZZZZZZZWEEEEIIII 0.2');
            }).then(() => {
                if (useMetaWriteRows.length > 0) {
                    return state.input.metaInstance.bulkWrite(
                        useMetaWriteRows,
                        'replication-down-write-meta'
                    );
                }
            }).then(() => {
                /**
                 * For better performance we do not await checkpoint writes,
                 * but to ensure order on parallel checkpoint writes,
                 * we have to use a queue.
                 */

                console.log('useCheckpointuseCheckpointuseCheckpointuseCheckpoint:');
                console.dir(useCheckpoint);

                state.checkpointQueue = state.checkpointQueue.then(() => setCheckpoint(
                    state,
                    'down',
                    useCheckpoint
                ));
            });
        }).catch(unhandledError => state.events.error.next(unhandledError));
        return persistenceQueue;
    }
}
