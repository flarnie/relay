/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactRelayTestMocker
 * @format
 */

'use strict';

const RelayNetwork = require('RelayNetwork');

const areEqual = require('areEqual');
const invariant = require('invariant');
const isRelayModernEnvironment = require('isRelayModernEnvironment');
const warning = require('warning');

import type {ConcreteOperationDefinition} from 'ConcreteQuery';
import type {CacheConfig} from 'RelayCombinedEnvironmentTypes';
import type {ConcreteBatch} from 'RelayConcreteNode';
import type {GraphQLTaggedNode} from 'RelayModernGraphQLTag';
import type {QueryPayload, PayloadError} from 'RelayNetworkTypes';
import type {Environment, OperationSelector} from 'RelayStoreTypes';
import type {Variables} from 'RelayTypes';

type DataWriteConfig = {
  environment: Environment,
  query: GraphQLTaggedNode,
  variables: Variables,
  payload: QueryPayload,
};

type NetworkWriteConfig = {
  environment: Environment,
  query: GraphQLTaggedNode,
  variables?: Variables,
  payload: QueryPayload | (Variables => QueryPayload),
};

type PendingFetch = {
  query: GraphQLTaggedNode,
  variables?: Variables,
  cacheConfig: CacheConfig,
  ident: string,
  deferred: {resolve: () => mixed, reject: () => mixed},
  operationSelector: OperationSelector,
};

/**
 * The next id to return from `generateId()`.
 */
let nextId = 0;

/**
 * The pending network fetches for the mocked network.
 */
let pendingFetches: Array<PendingFetch> = [];

class ReactRelayTestMocker {
  _environment: Environment;

  constructor(env) {
    if (!(env: any).hasMockedNetwork) {
      if (isRelayModernEnvironment(env)) {
        ReactRelayTestMocker._mockNetworkLayer(env);
      } else {
        warning(
          false,
          'Netork mocking is currently only supported in Relay Modern. ' +
            'You will not be able to resolve requests made with Relay ' +
            'Classic environments.',
        );
      }
    }

    this._environment = env;
  }

  /**
   * Get a unique id number (as a string). Note: will wrap around after 2^32
   * calls, if your test needs that many IDs.
   *
   * @returns a unique id string
   */
  static generateId(): string {
    const toRet = nextId.toString();
    nextId++;

    return toRet;
  }

  /**
   * Create a unique identifier for a (query, variables) pair.
   * @param operation: the operation associated with the query
   * @param variables: the variables associated with this invocation of the
   * query
   *
   * @returns a string which can later be used to uniquely identify this query
   * in the list of pending queries
   */
  static getIdentifier(
    operation: ConcreteBatch | ConcreteOperationDefinition,
  ): string {
    const queryName = operation.name;
    return queryName;
  }

  /**
   * Remove variables that we don't need from the query that will make it more
   * annoying to test (e.g. client_mutation_id, actor_id)
   */
  static stripUnused(variables: Variables): Variables {
    if (variables.input) {
      const toRemove = [
        'client_mutation_id',
        'actor_id',
        'clientMutationId',
        'actorId',
      ];
      toRemove.forEach(item => (variables.input[item] = undefined));
    }

    return variables;
  }

  /**
   * Replace the environment's network layer with a mocked out one to allow for
   * better testing. Mocking the network allows testing without using a mocked
   * out QueryRenderer, and will allow for easier testing of components wrapped
   * in refetch containers, for example. It also allows test writers to see how
   * their components behave under error conditions.
   */
  static _mockNetworkLayer(env: Environment): Environment {
    const fetch = (query, variables, cacheConfig) => {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const strippedVars = ReactRelayTestMocker.stripUnused(variables);
      const ident = ReactRelayTestMocker.getIdentifier(query, strippedVars);
      const {createOperationSelector, getOperation} = env.unstable_internal;

      const operation = getOperation((query: $FlowFixMe));
      const operationSelector = createOperationSelector(operation, variables);
      pendingFetches.push({
        ident,
        cacheConfig,
        deferred: {resolve, reject},
        query,
        variables,
        operationSelector,
      });
      return promise;
    };

    function isLoading(ident: string): boolean {
      return pendingFetches.some(pending => pending.ident === ident);
    }

    function resolveRawQuery(
      toResolve: PendingFetch,
      payload: QueryPayload,
    ): void {
      pendingFetches = pendingFetches.filter(pending => pending !== toResolve);

      const {deferred} = toResolve;
      deferred.resolve(payload);
      jest.runOnlyPendingTimers();
    }

    function rejectQuery(
      toResolve: PendingFetch,
      payload: {error: PayloadError},
    ): void {
      pendingFetches = pendingFetches.filter(pending => pending !== toResolve);

      const {deferred} = toResolve;
      deferred.reject(payload);
      jest.runOnlyPendingTimers();
    }

    (env: any).mock = {
      isLoading,
      rejectQuery,
      resolveRawQuery,
      fetch,
    };

    (env: any).hasMockedNetwork = true;

    (env: any).__setNet(RelayNetwork.create(fetch));
    return env;
  }

  /**
   * Write directly to the Relay store instead of trying to resolve a query that
   * was sent via the network.
   *
   * Use this method when testing a component wrapped in a fragment container
   * (via `createFragmentContainer`). The component under test should also be
   * wrapped in a `RelayTestRenderer`.
   */
  dataWrite(config: DataWriteConfig): void {
    const {query, variables, payload} = config;
    const {
      getOperation,
      createOperationSelector,
    } = this._environment.unstable_internal;

    invariant(
      payload.hasOwnProperty('data') && !payload.hasOwnProperty('errors'),
      'Only `data` can be written when using `writeDirect`. You may need to ' +
        'wrap your payload in an object like `{data: payload}`.',
    );

    const operation = getOperation((query: $FlowFixMe));
    const operationSelector = createOperationSelector(operation, variables);
    this._environment.commitPayload(operationSelector, payload.data);
  }

  /**
   * Write the data specified in config's payload to the instance's environment.
   *
   * @param config: an object containing the data to write and the query and
   * variables that the payload is simulating a response to
   */
  networkWrite(config: NetworkWriteConfig): void {
    invariant(
      (this._environment: any).hasMockedNetwork,
      'You cannot resolve queries without a mocked environment. Did you mean ' +
        'to use `writeDirect` instead?',
    );
    const {query, variables, payload} = config;
    const {getOperation} = this._environment.unstable_internal;

    // getOperation() expects a GraphQLTaggedNode, but tests still use string.
    const operation = getOperation((query: $FlowFixMe));

    const ident = ReactRelayTestMocker.getIdentifier(operation);

    let usedVars;

    if (variables) {
      const {createOperationSelector} = this._environment.unstable_internal;
      const operationSelector = createOperationSelector(query, variables);
      usedVars = ReactRelayTestMocker.stripUnused(operationSelector.variables);
    }

    let toResolve;
    pendingFetches.forEach(pending => {
      const pendingVars = pending.variables;
      if (pending.ident === ident) {
        invariant(
          !toResolve || variables,
          'Multiple queries with the same name are currently pending. You ' +
            'should pass variables to `write` so that it can determine which ' +
            'to resolve',
        );
        if (variables) {
          if (areEqual(pendingVars, usedVars)) {
            toResolve = pending;
          }
        } else {
          toResolve = pending;
        }
      }
    });

    const varMessage = usedVars
      ? ' - variables: ' + JSON.stringify(usedVars)
      : '';

    invariant(
      toResolve,
      'You are attempting to resolve a query that has not been fetched ' +
        '(%s%s).\n\tPlease ensure you passed the correct variables, or use ' +
        '`writeDirect` instead.',
      ident,
      varMessage,
    );

    const realPayload =
      typeof payload === 'function' ? payload(toResolve.variables) : payload;

    this._environment.mock.resolveRawQuery(toResolve, realPayload);
  }
}

module.exports = ReactRelayTestMocker;
