import Method from '@/Method';
import createHook from '@/createHook';
import { getResponseCache } from '@/storage/responseCache';
import { debounce, getHandlerMethod, promiseStatesHook } from '@/utils/helper';
import { _self, getContext, getMethodInternalKey, isFn, isNumber, sloughConfig } from '@alova/shared/function';
import {
  deleteAttr,
  falseValue,
  forEach,
  isArray,
  isSSR,
  len,
  promiseCatch,
  pushItem,
  trueValue,
  undefinedValue
} from '@alova/shared/vars';
import {
  AlovaMethodHandler,
  CompleteHandler,
  EnumHookType,
  ErrorHandler,
  ExportedType,
  FetchRequestState,
  FetcherHookConfig,
  FrontRequestHookConfig,
  FrontRequestState,
  Progress,
  SuccessHandler,
  UseHookConfig,
  WatcherHookConfig
} from '~/typings';
import useHookToSendRequest from './useHookToSendRequest';

const refCurrent = <T>(ref: { current: T }) => ref.current;
/**
 * 创建请求状态，统一处理useRequest、useWatcher、useFetcher中一致的逻辑
 * 该函数会调用statesHook的创建函数来创建对应的请求状态
 * 当该值为空时，表示useFetcher进入的，此时不需要data状态和缓存状态
 * @param methodInstance 请求方法对象
 * @param useHookConfig hook请求配置对象
 * @param initialData 初始data数据
 * @param immediate 是否立即发起请求
 * @param watchingStates 被监听的状态，如果未传入，直接调用handleRequest
 * @param debounceDelay 请求发起的延迟时间
 * @returns 当前的请求状态、操作函数及事件绑定函数
 */
export default function createRequestState<
  State,
  Computed,
  Watched,
  Export,
  Responded,
  Transformed,
  RequestConfig,
  Response,
  ResponseHeader,
  Config extends UseHookConfig<
    State,
    Computed,
    Watched,
    Export,
    Responded,
    Transformed,
    RequestConfig,
    Response,
    ResponseHeader
  >
>(
  hookType: EnumHookType,
  methodHandler:
    | Method<State, Computed, Watched, Export, Responded, Transformed, RequestConfig, Response, ResponseHeader>
    | AlovaMethodHandler<
        State,
        Computed,
        Watched,
        Export,
        Responded,
        Transformed,
        RequestConfig,
        Response,
        ResponseHeader
      >,
  useHookConfig: Config,
  initialData?: FrontRequestHookConfig<
    State,
    Computed,
    Watched,
    Export,
    Responded,
    Transformed,
    RequestConfig,
    Response,
    ResponseHeader
  >['initialData'],
  immediate = falseValue,
  watchingStates?: Export[],
  debounceDelay: WatcherHookConfig<
    State,
    Computed,
    Watched,
    Export,
    Responded,
    Transformed,
    RequestConfig,
    Response,
    ResponseHeader
  >['debounce'] = 0
) {
  // 复制一份config，防止外部传入相同useHookConfig导致vue2情况下的状态更新错乱问题
  useHookConfig = { ...useHookConfig };
  const statesHook = promiseStatesHook();
  const {
    create,
    export: exportState,
    effectRequest,
    update,
    memorize = _self,
    ref = val => ({ current: val })
  } = statesHook;
  const { middleware, __referingObj: referingObject = {} } = useHookConfig;
  let initialLoading = middleware ? falseValue : !!immediate;

  // 当立即发送请求时，需要通过是否强制请求和是否有缓存来确定初始loading值，这样做有以下两个好处：
  // 1. 在react下立即发送请求可以少渲染一次
  // 2. SSR渲染的html中，其初始视图为loading状态的，避免在客户端展现时的loading视图闪动
  // 3. 如果config.middleware中设置了`controlLoading`时，需要默认为false，但这边无法确定middleware中是否有调用`controlLoading`，因此条件只能放宽点，当有`config.middleware`时则初始`loading`为false
  if (immediate && !middleware) {
    // 调用getHandlerMethod时可能会报错，需要try/catch
    try {
      const methodInstance = getHandlerMethod(methodHandler);
      const alovaInstance = getContext(methodInstance);
      const cachedResponse: Responded | undefined = getResponseCache(
        alovaInstance.id,
        getMethodInternalKey(methodInstance)
      );
      const forceRequestFinally = sloughConfig(
        (useHookConfig as FrontRequestHookConfig<S, E, R, T, RC, RE, RH> | FetcherHookConfig).force ?? falseValue
      );
      initialLoading = !!forceRequestFinally || !cachedResponse;
    } catch (error) {}
  }

  const hookInstance = refCurrent(ref(createHook(hookType, useHookConfig)));
  const progress: Progress = {
    total: 0,
    loaded: 0
  };
  // 将外部传入的受监管的状态一同放到frontStates集合中
  const { managedStates = {} } = useHookConfig as FrontRequestHookConfig<S, E, R, T, RC, RE, RH>;
  const frontStates = {
    ...managedStates,
    data: create(isFn(initialData) ? initialData() : initialData, referingObject),
    loading: create(initialLoading, referingObject),
    error: create(undefinedValue as Error | undefined, referingObject),
    downloading: create({ ...progress }, referingObject),
    uploading: create({ ...progress }, referingObject)
  };
  const hasWatchingStates = watchingStates !== undefinedValue;
  // 初始化请求事件
  // 统一的发送请求函数
  const handleRequest = (
    handler: Method<S, E, R, T, RC, RE, RH> | AlovaMethodHandler<S, E, R, T, RC, RE, RH> = methodHandler,
    sendCallingArgs?: any[]
  ) => useHookToSendRequest(hookInstance, handler, sendCallingArgs);
  // 以捕获异常的方式调用handleRequest
  // 捕获异常避免异常继续向外抛出
  const wrapEffectRequest = () => {
    promiseCatch(handleRequest(), error => {
      // the existence of error handlers indicates that the error is catched.
      // in this case, we should not throw error.
      if (len(hookInstance.eh) <= 0) {
        throw error;
      }
    });
  };

  /**
   * ## react ##每次执行函数都需要重置以下项
   * */
  hookInstance.fs = frontStates;
  hookInstance.sh = [];
  hookInstance.eh = [];
  hookInstance.ch = [];
  hookInstance.c = useHookConfig;
  // 在服务端渲染时不发送请求
  if (!isSSR) {
    effectRequest(
      {
        handler:
          // watchingStates为数组时表示监听状态（包含空数组），为undefined时表示不监听状态
          hasWatchingStates
            ? debounce(wrapEffectRequest, (changedIndex?: number) =>
                isNumber(changedIndex) ? (isArray(debounceDelay) ? debounceDelay[changedIndex] : debounceDelay) : 0
              )
            : wrapEffectRequest,
        removeStates: () => forEach(hookInstance.rf, fn => fn()),
        saveStates: (states: FrontRequestState) => forEach(hookInstance.sf, fn => fn(states)),
        frontStates,
        watchingStates,
        immediate: immediate ?? trueValue
      },
      hookInstance
    );
  }

  type PartialFrontRequestState = Partial<FrontRequestState<boolean, R, Error | undefined, Progress, Progress>>;
  type PartialFetchRequestState = Partial<FetchRequestState<boolean, Error | undefined, Progress, Progress>>;
  return {
    loading: exportState(frontStates.loading, hookInstance) as unknown as ExportedType<boolean, S>,
    data: exportState(frontStates.data, hookInstance) as unknown as ExportedType<R, S>,
    error: exportState(frontStates.error, hookInstance) as unknown as ExportedType<Error | null, S>,
    get downloading() {
      hookInstance.ed = trueValue;
      return exportState(frontStates.downloading, hookInstance) as unknown as ExportedType<Progress, S>;
    },
    get uploading() {
      hookInstance.eu = trueValue;
      return exportState(frontStates.uploading, hookInstance) as unknown as ExportedType<Progress, S>;
    },
    onSuccess(handler: SuccessHandler<S, E, R, T, RC, RE, RH>) {
      pushItem(hookInstance.sh, handler);
    },
    onError(handler: ErrorHandler<S, E, R, T, RC, RE, RH>) {
      pushItem(hookInstance.eh, handler);
    },
    onComplete(handler: CompleteHandler<S, E, R, T, RC, RE, RH>) {
      pushItem(hookInstance.ch, handler);
    },
    update: memorize((newStates: PartialFrontRequestState | PartialFetchRequestState) => {
      // 当useFetcher调用时，其fetching使用的是loading，更新时需要转换过来
      const { fetching } = newStates as PartialFetchRequestState;
      if (fetching) {
        (newStates as PartialFrontRequestState).loading = fetching;
        deleteAttr(newStates as PartialFetchRequestState, 'fetching');
      }
      update(newStates, frontStates, hookInstance);
    }),
    abort: memorize(() => hookInstance.m && hookInstance.m.abort()),

    /**
     * 通过执行该方法来手动发起请求
     * @param sendCallingArgs 调用send函数时传入的参数
     * @param methodInstance 方法对象
     * @param isFetcher 是否为isFetcher调用
     * @returns 请求promise
     */
    send: memorize((sendCallingArgs?: any[], methodInstance?: Method<S, E, R, T, RC, RE, RH>) =>
      handleRequest(methodInstance, sendCallingArgs)
    ),

    /**
     * refering object that sharing some value with this object.
     */
    __referingObj: referingObject
  };
}
