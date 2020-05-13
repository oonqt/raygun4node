/*
 * raygun
 * https://github.com/MindscapeHQ/raygun4node
 *
 * Copyright (c) 2015 MindscapeHQ
 * Licensed under the MIT license.
 */

"use strict";

import type {
  RawUserData,
  OfflineStorageOptions,
  Tag,
  CustomData,
  RequestParams,
  Message,
  Transport
} from "./types";
import type { Request, Response, NextFunction } from "express";
import * as raygunTransport from "./raygun.transport";
import { RaygunMessageBuilder } from "./raygun.messageBuilder";
import { OfflineStorage } from "./raygun.offline";
import { RaygunBatchTransport } from "./raygun.batch";

type SendCB = (error: Error | null, items: string[] | undefined) => void;

type Hook<T> = (
  message: Message,
  exception: Error | string,
  customData: CustomData,
  request?: RequestParams,
  tags?: Tag[]
) => T;

type RaygunOptions = {
  apiKey: string;
  filters?: string[];
  host?: string;
  port?: number;
  useSSL?: boolean;
  onBeforeSend?: Hook<Message>;
  offlineStorage?: OfflineStorage;
  offlineStorageOptions?: OfflineStorageOptions;
  isOffline?: boolean;
  groupingKey?: Hook<string>;
  tags?: Tag[];
  useHumanStringForObject?: boolean;
  reportColumnNumbers?: boolean;
  innerErrorFieldName?: string;
  batch?: boolean;
  batchFrequency?: number;
};

const DEFAULT_BATCH_FREQUENCY = 1000; // ms

class Raygun {
  _apiKey: string | undefined;
  _filters: string[] = [];
  _user: RawUserData | undefined;
  _version: string = "";
  _host: string | undefined;
  _port: number | undefined;
  _useSSL: boolean | undefined;
  _onBeforeSend: Hook<Message> | undefined;
  _offlineStorage: OfflineStorage | undefined;
  _isOffline: boolean | undefined;
  _offlineStorageOptions: OfflineStorageOptions | undefined;
  _groupingKey: Hook<string> | undefined;
  _tags: Tag[] | undefined;
  _useHumanStringForObject: boolean | undefined;
  _reportColumnNumbers: boolean | undefined;
  _innerErrorFieldName: string | undefined;
  _batch: boolean = false;
  _batchTransport: RaygunBatchTransport | undefined;

  init(options: RaygunOptions) {
    this._apiKey = options.apiKey;
    this._filters = options.filters || [];
    this._host = options.host;
    this._port = options.port;
    this._useSSL = options.useSSL !== false;
    this._onBeforeSend = options.onBeforeSend;
    this._offlineStorage = options.offlineStorage || new OfflineStorage();
    this._offlineStorageOptions = options.offlineStorageOptions;
    this._isOffline = options.isOffline;
    this._groupingKey = options.groupingKey;
    this._tags = options.tags;
    this._useHumanStringForObject =
      options.useHumanStringForObject === undefined
        ? true
        : options.useHumanStringForObject;
    this._reportColumnNumbers = options.reportColumnNumbers;
    this._innerErrorFieldName = options.innerErrorFieldName || "cause"; // VError function to retrieve inner error;

    if (options.batch && this._apiKey) {
      this._batch = options.batch;
      this._batchTransport = new RaygunBatchTransport({
        interval: options.batchFrequency || DEFAULT_BATCH_FREQUENCY,
        httpOptions: {
          host: this._host,
          port: this._port,
          useSSL: !!this._useSSL,
          apiKey: this._apiKey,
        }
      });
      this._batchTransport.startProcessing();
    }

    this.expressHandler = this.expressHandler.bind(this);

    if (this._isOffline) {
      this._offlineStorage.init(this._offlineStorageOptions, this.transport());
    }

    return this;
  }

  user(req: Request): RawUserData | null {
    return null;
  }

  // This function is deprecated, is provided for legacy apps and will be
  // removed in 1.0: use raygun.user instead
  setUser(user: RawUserData) {
    this._user = user;
    return this;
  }

  expressCustomData(error: Error, request: Request) {
    return {};
  }

  setVersion(version: string) {
    this._version = version;
    return this;
  }

  onBeforeSend(onBeforeSend: Hook<Message>) {
    this._onBeforeSend = onBeforeSend;
    return this;
  }

  groupingKey(groupingKey: Hook<string>) {
    this._groupingKey = groupingKey;
    return this;
  }

  offline() {
    this.offlineStorage().init(this._offlineStorageOptions, this.transport());
    this._isOffline = true;
  }

  online(callback: SendCB) {
    this._isOffline = false;
    this.offlineStorage().send(callback);
  }

  setTags(tags: Tag[]) {
    this._tags = tags;
  }

  transport() {
    if (this._batch && this._batchTransport) {
      return this._batchTransport;
    }

    const client = this;

    return {
      send(message: string, callback: Function) {
        const apiKey = client._apiKey;

        if (!apiKey) {
          console.error(
            `Encountered an error sending an error to Raygun. No API key is configured, please ensure .init is called with api key. See docs for more info.`
          );
          return message;
        }

        return raygunTransport.send({
          message,
          callback,
          batch: false,
          http: {
            host: client._host,
            port: client._port,
            useSSL: !!client._useSSL,
            apiKey
          }
        });
      }
    }
  }

  send(
    exception: Error | string,
    customData: CustomData,
    callback: (err: Error | null) => void,
    request?: Request,
    tags?: Tag[]
  ): Message {
    let mergedTags: Tag[] = [];

    if (this._tags) {
      mergedTags = mergedTags.concat(this._tags);
    }

    if (tags) {
      mergedTags = mergedTags.concat(tags);
    }

    const builder = new RaygunMessageBuilder({
      filters: this._filters,
      useHumanStringForObject: this._useHumanStringForObject,
      reportColumnNumbers: this._reportColumnNumbers,
      innerErrorFieldName: this._innerErrorFieldName,
    })
      .setErrorDetails(exception)
      .setRequestDetails(request)
      .setMachineName()
      .setEnvironmentDetails()
      .setUserCustomData(customData)
      .setUser((request && this.user(request)) || this._user)
      .setVersion(this._version)
      .setTags(mergedTags);

    let message = builder.build();

    if (this._groupingKey) {
      message.details.groupingKey =
        typeof this._groupingKey === "function"
          ? this._groupingKey(message, exception, customData, request, tags)
          : null;
    }

    if (this._onBeforeSend) {
      message =
        typeof this._onBeforeSend === "function"
          ? this._onBeforeSend(message, exception, customData, request, tags)
          : message;
    }

    if (this._isOffline) {
      this.offlineStorage().save(JSON.stringify(message), callback);
    } else {
      this.transport().send(JSON.stringify(message), callback);
    }

    return message;
  }

  expressHandler(err: Error, req: Request, res: Response, next: NextFunction) {
    let customData;

    if (typeof this.expressCustomData === "function") {
      customData = this.expressCustomData(err, req);
    } else {
      customData = this.expressCustomData;
    }

    this.send(err, customData || {}, function () {}, req, [
      "UnhandledException",
    ]);
    next();
  }

  stop() {
    if (this._batchTransport) {
      this._batchTransport.stopProcessing();
    }
  }

  private offlineStorage(): OfflineStorage {
    let storage = this._offlineStorage;

    if (storage) {
      return storage;
    }

    storage = this._offlineStorage = new OfflineStorage();

    return storage;
  }
}

export const Client = Raygun;
