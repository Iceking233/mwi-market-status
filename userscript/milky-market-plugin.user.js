// ==UserScript==
// @name         MWI Market Status
// @name:zh-CN   MWI 市场状态增强
// @namespace    https://github.com/Iceking233/mwi-market-status
// @version      2026.4.3.2
// @description  Milky Way Idle market history, price chart, order book, and favorites tracking.
// @description:zh-CN  银河奶牛市场历史成交量、价格、订单簿显示、收藏夹实时记录涨跌。
// @author       Iceking233
// @homepageURL  https://github.com/Iceking233/mwi-market-status
// @supportURL   https://github.com/Iceking233/mwi-market-status/issues
// @match        https://www.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @icon         https://www.milkywayidle.com/favicon.svg
// @grant        none
// @noframes
// @require      https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js
// @require      https://cdn.jsdelivr.net/npm/chartjs-plugin-crosshair@2.0.0/dist/chartjs-plugin-crosshair.min.js
// @require      https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js
// @run-at       document-start
// @license      MIT
// ==/UserScript==
/*
1. 感谢mooket作者IOMisaka，本插件在mooket的基础上开发，提供了更多功能和更好的用户体验！
2. 感谢q7提供市场数据支持。
3. 感谢MWI Api作者holychikenz，提供了历史数据库！
4. 感谢Joey、Baozhi、ColaCola、Hyh_fish的测试和大力支持！
*/

(function () {
  'use strict';
  let injectSpace = "mwi";//use window.mwi to access the injected object
  if (window[injectSpace]) return;//已经注入
  //优先注册ob
  const observer = new MutationObserver(() => {
    const el = document.querySelector('[class^="GamePage"]');
    if (el) {
      observer.disconnect();
      patchScript();
    }
  });
  observer.observe(document, { childList: true, subtree: true });
  let mwi = {//供外部调用的接口
    //由于脚本加载问题，注入有可能失败
    //修改了hookCallback，添加了回调前和回调后处理
    version: "0.7.1",//版本号，未改动原有接口只更新最后一个版本号，更改了接口会更改次版本号，主版本暂时不更新，等稳定之后再考虑主版本号更新
    MWICoreInitialized: false,//是否初始化完成，完成会还会通过window发送一个自定义事件 MWICoreInitialized
    game: null,//注入游戏对象，可以直接访问游戏中的大量数据和方法以及消息事件等
    lang: null,//语言翻译, 例如中文物品lang.zh.translation.itemNames['/items/coin']

    //////非注入接口，保证可以使用的功能//////
    ///需要等待加载完成才能使用

    coreMarket: null,//coreMarket.marketData 格式{"/items/apple_yogurt:0":{ask,bid,time}}
    initCharacterData: null,
    initClientData: null,
    get character() { return this.game?.state?.character || this.initCharacterData?.character },

    ///不需要等待加载的

    isZh: true,//是否中文
    /* marketJson兼容接口 */
    get marketJsonOld() {
      return this.coreMarket && new Proxy(this.coreMarket, {
        get(coreMarket, prop) {
          if (prop === "market") {
            return new Proxy(coreMarket, {
              get(coreMarket, itemHridOrName) {
                return coreMarket.getItemPrice(itemHridOrName);
              }
            });
          }
          return null;
        }

      });
    },
    get marketJson() {
      return mwi.coreMarket && new Proxy({}, {
        get(_, marketData) {
          if (marketData === "marketData")
            return new Proxy({}, {
              get(_, itemHridOrName) {
                return new Proxy({}, {
                  get(_, itemLevel) {
                    return new Proxy({}, {
                      get(_, objProp) {
                        const item = mwi.coreMarket?.getItemPrice(itemHridOrName, itemLevel, true);
                        switch (objProp) {
                          case "a":
                            return item?.ask;
                          case "b":
                            return item?.bid;
                          case "p":
                            return item?.avg ?? 0;
                          case "v":
                            return item?.volume ?? 0;
                          case "avg":
                            return item?.avg ?? 0;
                          case "volume":
                            return item?.volume ?? 0;
                          case "time":
                            return item?.time;
                        }
                        return -1;
                      }
                    })
                  }
                })
              }
            })
        }
      })
    },

    itemNameToHridDict: null,//物品名称反查表


    ensureItemHrid: function (itemHridOrName) {
      let itemHrid = this.itemNameToHridDict[itemHridOrName];
      if (itemHrid) return itemHrid;
      if (itemHridOrName?.startsWith("/items/")) return itemHridOrName;
      return null;
    },//各种名字转itemHrid，找不到返回原itemHrid或者null
    getItemDetail: function (itemHrid) {
      return this.initClientData?.itemDetailMap && this.initClientData.itemDetailMap[itemHrid];
    },
    hookMessage: hookMessage,//hook 游戏websocket消息 例如聊天消息mwi.hookMessage("chat_message_received",obj=>{console.log(obj)})
    hookCallback: hookCallback,//hook回调，可以hook游戏处理事件调用前后，方便做统计处理？ 例如聊天消息mwi.hookCallback("handleMessageChatMessageReceived",obj=>{console.log("before")}，obj=>{console.log("after")})
    fetchWithTimeout: fetchWithTimeout,//带超时的fetch
  };
  window[injectSpace] = mwi;
  function getBrowserLanguage() {
    const langs = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language, navigator.userLanguage].filter(Boolean);
    return (langs.find(Boolean) || "").toLowerCase();
  }
  function detectLocaleIsZh(lang) {
    return typeof lang === "string" && lang.toLowerCase().startsWith("zh");
  }
  function getPreferredLanguage() {
    return localStorage.getItem("i18nextLng") || getBrowserLanguage();
  }
  function refreshLanguageState() {
    mwi.isZh = detectLocaleIsZh(getPreferredLanguage());
    return mwi.isZh;
  }
  try {
    let decData = LZString.decompressFromUTF16(localStorage.getItem("initClientData"));
    mwi.initClientData = JSON.parse(decData);
  } catch {
    mwi.initClientData = JSON.parse("{}");
  }
  refreshLanguageState();

  const originalSetItem = localStorage.setItem;
  localStorage.setItem = function (key, value) {
    const event = new Event('localStorageChanged');
    event.key = key;
    event.newValue = value;
    event.oldValue = localStorage.getItem(key);
    originalSetItem.apply(this, arguments);
    dispatchEvent(event);

  };

  addEventListener('localStorageChanged', function (event) {
    if (event.key === "i18nextLng") {
      console.log(`i18nextLng changed: ${event.key} = ${event.newValue}`);
      refreshLanguageState();
      dispatchEvent(new Event("MWILangChanged"));
    }
  });
  addEventListener("languagechange", () => {
    if (localStorage.getItem("i18nextLng")) return;
    refreshLanguageState();
    dispatchEvent(new Event("MWILangChanged"));
  });
  async function patchScript() {
    try {
      window[injectSpace].game = (e => e?.[Reflect.ownKeys(e).find(k => k.startsWith('__reactFiber$'))]?.return?.stateNode)(document.querySelector('[class^="GamePage"]'));
      window[injectSpace].lang = window[injectSpace].game.props.i18n.options.resources;
      console.info('MWICore patched successfully.')
    } catch (error) {
      console.error('MWICore patching failed:', error);
    }
  }


  function hookWS() {
    const dataProperty = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
    const oriGet = dataProperty.get;
    dataProperty.get = hookedGet;
    Object.defineProperty(MessageEvent.prototype, "data", dataProperty);

    function hookedGet() {
      const socket = this.currentTarget;
      if (!(socket instanceof WebSocket)) {
        return oriGet.call(this);
      }
      if (socket.url.indexOf("api.milkywayidle.com/ws") <= -1 && socket.url.indexOf("api.milkywayidlecn.com/ws") <= -1) {
        return oriGet.call(this);
      }
      const message = oriGet.call(this);
      Object.defineProperty(this, "data", { value: message }); // Anti-loop

      try {
        let obj = JSON.parse(message);
        if (obj?.type) {
          if (obj.type === "init_character_data") {
            mwi.initCharacterData = obj;
          } else if (obj.type === "init_client_data") {
            mwi.initClientData = obj;
          }

          dispatchEvent(new CustomEvent("MWI_" + obj.type, { detail: obj }));
        }
      } catch { console.error("dispatch error."); }

      return message;
    }
  }
  hookWS();
  /**
   * Hook游戏消息在处理之前，随时可用
   * @param {string} message.type 消息类型，ws钩子，必定可用，仅在游戏处理之前调用beforeFunc
   * @param {Function} beforeFunc 前处理函数
   */
  function hookMessage(messageType, beforeFunc) {
    if (messageType && beforeFunc) {
      //游戏websocket消息hook
      addEventListener("MWI_" + messageType, (e) => beforeFunc(e.detail));
    } else {
      console.warn("messageType or beforeFunc is missing");
    }
  }
  /**
   * Hook游戏回调函数，仅在游戏注入成功时可用，会调用beforeFunc和afterFunc
   * @param {string} callbackProp 游戏处理回调函数名mwi.game.handleMessage*，仅当注入成功时可用，会调用beforeFunc和afterFunc
   * @param {Function} beforeFunc 前处理函数
   * @param {Function} afterFunc 后处理函数
   */
  function hookCallback(callbackProp, beforeFunc, afterFunc) {
    if (callbackProp && mwi?.game) {//优先使用游戏回调hook
      const targetObj = mwi.game;
      const originalCallback = targetObj[callbackProp];

      if (!originalCallback || !targetObj) {
        throw new Error(`Callback ${callbackProp} does not exist`);
      }

      targetObj[callbackProp] = function (...args) {
        // 前处理
        try {
          if (beforeFunc) beforeFunc(...args);
        } catch { }
        // 原始回调函数调用
        const result = originalCallback.apply(this, args);
        // 后处理
        try {
          if (afterFunc) afterFunc(result, ...args);
        } catch { }
        return result;
      };

      // 返回取消Hook的方法
      return () => {
        targetObj[callbackProp] = originalCallback;
      };
    } else {
      console.warn("hookCallback error");
    }
  }
  /**
   * 带超时功能的fetch封装
   * @param {string} url - 请求URL
   * @param {object} options - fetch选项
   * @param {number} timeout - 超时时间(毫秒)，默认10秒
   * @returns {Promise} - 返回fetch的Promise
   */
  function fetchWithTimeout(url, options = {}, timeout = 10000) {
    // 创建AbortController实例
    const controller = new AbortController();
    const { signal } = controller;

    // 设置超时计时器
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`请求超时: ${timeout}ms`));
    }, timeout);

    // 合并选项，添加signal
    const fetchOptions = {
      ...options,
      signal
    };

    // 发起fetch请求
    return fetch(url, fetchOptions)
      .then(response => {
        // 清除超时计时器
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP错误! 状态码: ${response.status}`);
        }
        return response;
      })
      .catch(error => {
        // 清除超时计时器
        clearTimeout(timeoutId);

        // 如果是中止错误，重新抛出超时错误
        if (error.name === 'AbortError') {
          throw new Error(`请求超时: ${timeout}ms`);
        }
        throw error;
      });
  }


  function staticInit() {
    /*静态初始化，手动提取的游戏数据*/
    mwi.lang = {
      en: {
        translation: {
          ...{
            itemNames: {
                '/items/coin': 'Coin',
                '/items/task_token': 'Task Token',
                '/items/labyrinth_token': 'Labyrinth Token',
                '/items/chimerical_token': 'Chimerical Token',
                '/items/sinister_token': 'Sinister Token',
                '/items/enchanted_token': 'Enchanted Token',
                '/items/pirate_token': 'Pirate Token',
                '/items/cowbell': 'Cowbell',
                '/items/bag_of_10_cowbells': 'Bag Of 10 Cowbells',
                '/items/purples_gift': 'Purple\'s Gift',
                '/items/small_meteorite_cache': 'Small Meteorite Cache',
                '/items/medium_meteorite_cache': 'Medium Meteorite Cache',
                '/items/large_meteorite_cache': 'Large Meteorite Cache',
                '/items/small_artisans_crate': 'Small Artisan\'s Crate',
                '/items/medium_artisans_crate': 'Medium Artisan\'s Crate',
                '/items/large_artisans_crate': 'Large Artisan\'s Crate',
                '/items/small_treasure_chest': 'Small Treasure Chest',
                '/items/medium_treasure_chest': 'Medium Treasure Chest',
                '/items/large_treasure_chest': 'Large Treasure Chest',
                '/items/chimerical_chest': 'Chimerical Chest',
                '/items/chimerical_refinement_chest': 'Chimerical Refinement Chest',
                '/items/sinister_chest': 'Sinister Chest',
                '/items/sinister_refinement_chest': 'Sinister Refinement Chest',
                '/items/enchanted_chest': 'Enchanted Chest',
                '/items/enchanted_refinement_chest': 'Enchanted Refinement Chest',
                '/items/pirate_chest': 'Pirate Chest',
                '/items/pirate_refinement_chest': 'Pirate Refinement Chest',
                '/items/purdoras_box_skilling': 'Purdora\'s Box (Skilling)',
                '/items/purdoras_box_combat': 'Purdora\'s Box (Combat)',
                '/items/labyrinth_refinement_chest': 'Labyrinth Refinement Chest',
                '/items/seal_of_gathering': 'Seal Of Gathering',
                '/items/seal_of_gourmet': 'Seal Of Gourmet',
                '/items/seal_of_processing': 'Seal Of Processing',
                '/items/seal_of_efficiency': 'Seal Of Efficiency',
                '/items/seal_of_action_speed': 'Seal Of Action Speed',
                '/items/seal_of_combat_drop': 'Seal Of Combat Drop',
                '/items/seal_of_attack_speed': 'Seal Of Attack Speed',
                '/items/seal_of_cast_speed': 'Seal Of Cast Speed',
                '/items/seal_of_damage': 'Seal Of Damage',
                '/items/seal_of_critical_rate': 'Seal Of Critical Rate',
                '/items/seal_of_wisdom': 'Seal Of Wisdom',
                '/items/seal_of_rare_find': 'Seal Of Rare Find',
                '/items/blue_key_fragment': 'Blue Key Fragment',
                '/items/green_key_fragment': 'Green Key Fragment',
                '/items/purple_key_fragment': 'Purple Key Fragment',
                '/items/white_key_fragment': 'White Key Fragment',
                '/items/orange_key_fragment': 'Orange Key Fragment',
                '/items/brown_key_fragment': 'Brown Key Fragment',
                '/items/stone_key_fragment': 'Stone Key Fragment',
                '/items/dark_key_fragment': 'Dark Key Fragment',
                '/items/burning_key_fragment': 'Burning Key Fragment',
                '/items/chimerical_entry_key': 'Chimerical Entry Key',
                '/items/chimerical_chest_key': 'Chimerical Chest Key',
                '/items/sinister_entry_key': 'Sinister Entry Key',
                '/items/sinister_chest_key': 'Sinister Chest Key',
                '/items/enchanted_entry_key': 'Enchanted Entry Key',
                '/items/enchanted_chest_key': 'Enchanted Chest Key',
                '/items/pirate_entry_key': 'Pirate Entry Key',
                '/items/pirate_chest_key': 'Pirate Chest Key',
                '/items/donut': 'Donut',
                '/items/blueberry_donut': 'Blueberry Donut',
                '/items/blackberry_donut': 'Blackberry Donut',
                '/items/strawberry_donut': 'Strawberry Donut',
                '/items/mooberry_donut': 'Mooberry Donut',
                '/items/marsberry_donut': 'Marsberry Donut',
                '/items/spaceberry_donut': 'Spaceberry Donut',
                '/items/cupcake': 'Cupcake',
                '/items/blueberry_cake': 'Blueberry Cake',
                '/items/blackberry_cake': 'Blackberry Cake',
                '/items/strawberry_cake': 'Strawberry Cake',
                '/items/mooberry_cake': 'Mooberry Cake',
                '/items/marsberry_cake': 'Marsberry Cake',
                '/items/spaceberry_cake': 'Spaceberry Cake',
                '/items/gummy': 'Gummy',
                '/items/apple_gummy': 'Apple Gummy',
                '/items/orange_gummy': 'Orange Gummy',
                '/items/plum_gummy': 'Plum Gummy',
                '/items/peach_gummy': 'Peach Gummy',
                '/items/dragon_fruit_gummy': 'Dragon Fruit Gummy',
                '/items/star_fruit_gummy': 'Star Fruit Gummy',
                '/items/yogurt': 'Yogurt',
                '/items/apple_yogurt': 'Apple Yogurt',
                '/items/orange_yogurt': 'Orange Yogurt',
                '/items/plum_yogurt': 'Plum Yogurt',
                '/items/peach_yogurt': 'Peach Yogurt',
                '/items/dragon_fruit_yogurt': 'Dragon Fruit Yogurt',
                '/items/star_fruit_yogurt': 'Star Fruit Yogurt',
                '/items/milking_tea': 'Milking Tea',
                '/items/foraging_tea': 'Foraging Tea',
                '/items/woodcutting_tea': 'Woodcutting Tea',
                '/items/cooking_tea': 'Cooking Tea',
                '/items/brewing_tea': 'Brewing Tea',
                '/items/alchemy_tea': 'Alchemy Tea',
                '/items/enhancing_tea': 'Enhancing Tea',
                '/items/cheesesmithing_tea': 'Cheesesmithing Tea',
                '/items/crafting_tea': 'Crafting Tea',
                '/items/tailoring_tea': 'Tailoring Tea',
                '/items/super_milking_tea': 'Super Milking Tea',
                '/items/super_foraging_tea': 'Super Foraging Tea',
                '/items/super_woodcutting_tea': 'Super Woodcutting Tea',
                '/items/super_cooking_tea': 'Super Cooking Tea',
                '/items/super_brewing_tea': 'Super Brewing Tea',
                '/items/super_alchemy_tea': 'Super Alchemy Tea',
                '/items/super_enhancing_tea': 'Super Enhancing Tea',
                '/items/super_cheesesmithing_tea': 'Super Cheesesmithing Tea',
                '/items/super_crafting_tea': 'Super Crafting Tea',
                '/items/super_tailoring_tea': 'Super Tailoring Tea',
                '/items/ultra_milking_tea': 'Ultra Milking Tea',
                '/items/ultra_foraging_tea': 'Ultra Foraging Tea',
                '/items/ultra_woodcutting_tea': 'Ultra Woodcutting Tea',
                '/items/ultra_cooking_tea': 'Ultra Cooking Tea',
                '/items/ultra_brewing_tea': 'Ultra Brewing Tea',
                '/items/ultra_alchemy_tea': 'Ultra Alchemy Tea',
                '/items/ultra_enhancing_tea': 'Ultra Enhancing Tea',
                '/items/ultra_cheesesmithing_tea': 'Ultra Cheesesmithing Tea',
                '/items/ultra_crafting_tea': 'Ultra Crafting Tea',
                '/items/ultra_tailoring_tea': 'Ultra Tailoring Tea',
                '/items/gathering_tea': 'Gathering Tea',
                '/items/gourmet_tea': 'Gourmet Tea',
                '/items/wisdom_tea': 'Wisdom Tea',
                '/items/processing_tea': 'Processing Tea',
                '/items/efficiency_tea': 'Efficiency Tea',
                '/items/artisan_tea': 'Artisan Tea',
                '/items/catalytic_tea': 'Catalytic Tea',
                '/items/blessed_tea': 'Blessed Tea',
                '/items/stamina_coffee': 'Stamina Coffee',
                '/items/intelligence_coffee': 'Intelligence Coffee',
                '/items/defense_coffee': 'Defense Coffee',
                '/items/attack_coffee': 'Attack Coffee',
                '/items/melee_coffee': 'Melee Coffee',
                '/items/ranged_coffee': 'Ranged Coffee',
                '/items/magic_coffee': 'Magic Coffee',
                '/items/super_stamina_coffee': 'Super Stamina Coffee',
                '/items/super_intelligence_coffee': 'Super Intelligence Coffee',
                '/items/super_defense_coffee': 'Super Defense Coffee',
                '/items/super_attack_coffee': 'Super Attack Coffee',
                '/items/super_melee_coffee': 'Super Melee Coffee',
                '/items/super_ranged_coffee': 'Super Ranged Coffee',
                '/items/super_magic_coffee': 'Super Magic Coffee',
                '/items/ultra_stamina_coffee': 'Ultra Stamina Coffee',
                '/items/ultra_intelligence_coffee': 'Ultra Intelligence Coffee',
                '/items/ultra_defense_coffee': 'Ultra Defense Coffee',
                '/items/ultra_attack_coffee': 'Ultra Attack Coffee',
                '/items/ultra_melee_coffee': 'Ultra Melee Coffee',
                '/items/ultra_ranged_coffee': 'Ultra Ranged Coffee',
                '/items/ultra_magic_coffee': 'Ultra Magic Coffee',
                '/items/wisdom_coffee': 'Wisdom Coffee',
                '/items/lucky_coffee': 'Lucky Coffee',
                '/items/swiftness_coffee': 'Swiftness Coffee',
                '/items/channeling_coffee': 'Channeling Coffee',
                '/items/critical_coffee': 'Critical Coffee',
                '/items/poke': 'Poke',
                '/items/impale': 'Impale',
                '/items/puncture': 'Puncture',
                '/items/penetrating_strike': 'Penetrating Strike',
                '/items/scratch': 'Scratch',
                '/items/cleave': 'Cleave',
                '/items/maim': 'Maim',
                '/items/crippling_slash': 'Crippling Slash',
                '/items/smack': 'Smack',
                '/items/sweep': 'Sweep',
                '/items/stunning_blow': 'Stunning Blow',
                '/items/fracturing_impact': 'Fracturing Impact',
                '/items/shield_bash': 'Shield Bash',
                '/items/quick_shot': 'Quick Shot',
                '/items/aqua_arrow': 'Aqua Arrow',
                '/items/flame_arrow': 'Flame Arrow',
                '/items/rain_of_arrows': 'Rain Of Arrows',
                '/items/silencing_shot': 'Silencing Shot',
                '/items/steady_shot': 'Steady Shot',
                '/items/pestilent_shot': 'Pestilent Shot',
                '/items/penetrating_shot': 'Penetrating Shot',
                '/items/water_strike': 'Water Strike',
                '/items/ice_spear': 'Ice Spear',
                '/items/frost_surge': 'Frost Surge',
                '/items/mana_spring': 'Mana Spring',
                '/items/entangle': 'Entangle',
                '/items/toxic_pollen': 'Toxic Pollen',
                '/items/natures_veil': 'Nature\'s Veil',
                '/items/life_drain': 'Life Drain',
                '/items/fireball': 'Fireball',
                '/items/flame_blast': 'Flame Blast',
                '/items/firestorm': 'Firestorm',
                '/items/smoke_burst': 'Smoke Burst',
                '/items/minor_heal': 'Minor Heal',
                '/items/heal': 'Heal',
                '/items/quick_aid': 'Quick Aid',
                '/items/rejuvenate': 'Rejuvenate',
                '/items/taunt': 'Taunt',
                '/items/provoke': 'Provoke',
                '/items/toughness': 'Toughness',
                '/items/elusiveness': 'Elusiveness',
                '/items/precision': 'Precision',
                '/items/berserk': 'Berserk',
                '/items/elemental_affinity': 'Elemental Affinity',
                '/items/frenzy': 'Frenzy',
                '/items/spike_shell': 'Spike Shell',
                '/items/retribution': 'Retribution',
                '/items/vampirism': 'Vampirism',
                '/items/revive': 'Revive',
                '/items/insanity': 'Insanity',
                '/items/invincible': 'Invincible',
                '/items/speed_aura': 'Speed Aura',
                '/items/guardian_aura': 'Guardian Aura',
                '/items/fierce_aura': 'Fierce Aura',
                '/items/critical_aura': 'Critical Aura',
                '/items/mystic_aura': 'Mystic Aura',
                '/items/gobo_stabber': 'Gobo Stabber',
                '/items/gobo_slasher': 'Gobo Slasher',
                '/items/gobo_smasher': 'Gobo Smasher',
                '/items/spiked_bulwark': 'Spiked Bulwark',
                '/items/werewolf_slasher': 'Werewolf Slasher',
                '/items/griffin_bulwark': 'Griffin Bulwark',
                '/items/griffin_bulwark_refined': 'Griffin Bulwark (R)',
                '/items/gobo_shooter': 'Gobo Shooter',
                '/items/vampiric_bow': 'Vampiric Bow',
                '/items/cursed_bow': 'Cursed Bow',
                '/items/cursed_bow_refined': 'Cursed Bow (R)',
                '/items/gobo_boomstick': 'Gobo Boomstick',
                '/items/cheese_bulwark': 'Cheese Bulwark',
                '/items/verdant_bulwark': 'Verdant Bulwark',
                '/items/azure_bulwark': 'Azure Bulwark',
                '/items/burble_bulwark': 'Burble Bulwark',
                '/items/crimson_bulwark': 'Crimson Bulwark',
                '/items/rainbow_bulwark': 'Rainbow Bulwark',
                '/items/holy_bulwark': 'Holy Bulwark',
                '/items/wooden_bow': 'Wooden Bow',
                '/items/birch_bow': 'Birch Bow',
                '/items/cedar_bow': 'Cedar Bow',
                '/items/purpleheart_bow': 'Purpleheart Bow',
                '/items/ginkgo_bow': 'Ginkgo Bow',
                '/items/redwood_bow': 'Redwood Bow',
                '/items/arcane_bow': 'Arcane Bow',
                '/items/stalactite_spear': 'Stalactite Spear',
                '/items/granite_bludgeon': 'Granite Bludgeon',
                '/items/furious_spear': 'Furious Spear',
                '/items/furious_spear_refined': 'Furious Spear (R)',
                '/items/regal_sword': 'Regal Sword',
                '/items/regal_sword_refined': 'Regal Sword (R)',
                '/items/chaotic_flail': 'Chaotic Flail',
                '/items/chaotic_flail_refined': 'Chaotic Flail (R)',
                '/items/soul_hunter_crossbow': 'Soul Hunter Crossbow',
                '/items/sundering_crossbow': 'Sundering Crossbow',
                '/items/sundering_crossbow_refined': 'Sundering Crossbow (R)',
                '/items/frost_staff': 'Frost Staff',
                '/items/infernal_battlestaff': 'Infernal Battlestaff',
                '/items/jackalope_staff': 'Jackalope Staff',
                '/items/rippling_trident': 'Rippling Trident',
                '/items/rippling_trident_refined': 'Rippling Trident (R)',
                '/items/blooming_trident': 'Blooming Trident',
                '/items/blooming_trident_refined': 'Blooming Trident (R)',
                '/items/blazing_trident': 'Blazing Trident',
                '/items/blazing_trident_refined': 'Blazing Trident (R)',
                '/items/cheese_sword': 'Cheese Sword',
                '/items/verdant_sword': 'Verdant Sword',
                '/items/azure_sword': 'Azure Sword',
                '/items/burble_sword': 'Burble Sword',
                '/items/crimson_sword': 'Crimson Sword',
                '/items/rainbow_sword': 'Rainbow Sword',
                '/items/holy_sword': 'Holy Sword',
                '/items/cheese_spear': 'Cheese Spear',
                '/items/verdant_spear': 'Verdant Spear',
                '/items/azure_spear': 'Azure Spear',
                '/items/burble_spear': 'Burble Spear',
                '/items/crimson_spear': 'Crimson Spear',
                '/items/rainbow_spear': 'Rainbow Spear',
                '/items/holy_spear': 'Holy Spear',
                '/items/cheese_mace': 'Cheese Mace',
                '/items/verdant_mace': 'Verdant Mace',
                '/items/azure_mace': 'Azure Mace',
                '/items/burble_mace': 'Burble Mace',
                '/items/crimson_mace': 'Crimson Mace',
                '/items/rainbow_mace': 'Rainbow Mace',
                '/items/holy_mace': 'Holy Mace',
                '/items/wooden_crossbow': 'Wooden Crossbow',
                '/items/birch_crossbow': 'Birch Crossbow',
                '/items/cedar_crossbow': 'Cedar Crossbow',
                '/items/purpleheart_crossbow': 'Purpleheart Crossbow',
                '/items/ginkgo_crossbow': 'Ginkgo Crossbow',
                '/items/redwood_crossbow': 'Redwood Crossbow',
                '/items/arcane_crossbow': 'Arcane Crossbow',
                '/items/wooden_water_staff': 'Wooden Water Staff',
                '/items/birch_water_staff': 'Birch Water Staff',
                '/items/cedar_water_staff': 'Cedar Water Staff',
                '/items/purpleheart_water_staff': 'Purpleheart Water Staff',
                '/items/ginkgo_water_staff': 'Ginkgo Water Staff',
                '/items/redwood_water_staff': 'Redwood Water Staff',
                '/items/arcane_water_staff': 'Arcane Water Staff',
                '/items/wooden_nature_staff': 'Wooden Nature Staff',
                '/items/birch_nature_staff': 'Birch Nature Staff',
                '/items/cedar_nature_staff': 'Cedar Nature Staff',
                '/items/purpleheart_nature_staff': 'Purpleheart Nature Staff',
                '/items/ginkgo_nature_staff': 'Ginkgo Nature Staff',
                '/items/redwood_nature_staff': 'Redwood Nature Staff',
                '/items/arcane_nature_staff': 'Arcane Nature Staff',
                '/items/wooden_fire_staff': 'Wooden Fire Staff',
                '/items/birch_fire_staff': 'Birch Fire Staff',
                '/items/cedar_fire_staff': 'Cedar Fire Staff',
                '/items/purpleheart_fire_staff': 'Purpleheart Fire Staff',
                '/items/ginkgo_fire_staff': 'Ginkgo Fire Staff',
                '/items/redwood_fire_staff': 'Redwood Fire Staff',
                '/items/arcane_fire_staff': 'Arcane Fire Staff',
                '/items/eye_watch': 'Eye Watch',
                '/items/snake_fang_dirk': 'Snake Fang Dirk',
                '/items/vision_shield': 'Vision Shield',
                '/items/gobo_defender': 'Gobo Defender',
                '/items/vampire_fang_dirk': 'Vampire Fang Dirk',
                '/items/knights_aegis': 'Knight\'s Aegis',
                '/items/knights_aegis_refined': 'Knight\'s Aegis (R)',
                '/items/treant_shield': 'Treant Shield',
                '/items/manticore_shield': 'Manticore Shield',
                '/items/tome_of_healing': 'Tome Of Healing',
                '/items/tome_of_the_elements': 'Tome Of The Elements',
                '/items/watchful_relic': 'Watchful Relic',
                '/items/bishops_codex': 'Bishop\'s Codex',
                '/items/bishops_codex_refined': 'Bishop\'s Codex (R)',
                '/items/cheese_buckler': 'Cheese Buckler',
                '/items/verdant_buckler': 'Verdant Buckler',
                '/items/azure_buckler': 'Azure Buckler',
                '/items/burble_buckler': 'Burble Buckler',
                '/items/crimson_buckler': 'Crimson Buckler',
                '/items/rainbow_buckler': 'Rainbow Buckler',
                '/items/holy_buckler': 'Holy Buckler',
                '/items/wooden_shield': 'Wooden Shield',
                '/items/birch_shield': 'Birch Shield',
                '/items/cedar_shield': 'Cedar Shield',
                '/items/purpleheart_shield': 'Purpleheart Shield',
                '/items/ginkgo_shield': 'Ginkgo Shield',
                '/items/redwood_shield': 'Redwood Shield',
                '/items/arcane_shield': 'Arcane Shield',
                '/items/gatherer_cape': 'Gatherer Cape',
                '/items/gatherer_cape_refined': 'Gatherer Cape (R)',
                '/items/artificer_cape': 'Artificer Cape',
                '/items/artificer_cape_refined': 'Artificer Cape (R)',
                '/items/culinary_cape': 'Culinary Cape',
                '/items/culinary_cape_refined': 'Culinary Cape (R)',
                '/items/chance_cape': 'Chance Cape',
                '/items/chance_cape_refined': 'Chance Cape (R)',
                '/items/sinister_cape': 'Sinister Cape',
                '/items/sinister_cape_refined': 'Sinister Cape (R)',
                '/items/chimerical_quiver': 'Chimerical Quiver',
                '/items/chimerical_quiver_refined': 'Chimerical Quiver (R)',
                '/items/enchanted_cloak': 'Enchanted Cloak',
                '/items/enchanted_cloak_refined': 'Enchanted Cloak (R)',
                '/items/red_culinary_hat': 'Red Culinary Hat',
                '/items/snail_shell_helmet': 'Snail Shell Helmet',
                '/items/vision_helmet': 'Vision Helmet',
                '/items/fluffy_red_hat': 'Fluffy Red Hat',
                '/items/corsair_helmet': 'Corsair Helmet',
                '/items/corsair_helmet_refined': 'Corsair Helmet (R)',
                '/items/acrobatic_hood': 'Acrobatic Hood',
                '/items/acrobatic_hood_refined': 'Acrobatic Hood (R)',
                '/items/magicians_hat': 'Magician\'s Hat',
                '/items/magicians_hat_refined': 'Magician\'s Hat (R)',
                '/items/cheese_helmet': 'Cheese Helmet',
                '/items/verdant_helmet': 'Verdant Helmet',
                '/items/azure_helmet': 'Azure Helmet',
                '/items/burble_helmet': 'Burble Helmet',
                '/items/crimson_helmet': 'Crimson Helmet',
                '/items/rainbow_helmet': 'Rainbow Helmet',
                '/items/holy_helmet': 'Holy Helmet',
                '/items/rough_hood': 'Rough Hood',
                '/items/reptile_hood': 'Reptile Hood',
                '/items/gobo_hood': 'Gobo Hood',
                '/items/beast_hood': 'Beast Hood',
                '/items/umbral_hood': 'Umbral Hood',
                '/items/cotton_hat': 'Cotton Hat',
                '/items/linen_hat': 'Linen Hat',
                '/items/bamboo_hat': 'Bamboo Hat',
                '/items/silk_hat': 'Silk Hat',
                '/items/radiant_hat': 'Radiant Hat',
                '/items/dairyhands_top': 'Dairyhand\'s Top',
                '/items/foragers_top': 'Forager\'s Top',
                '/items/lumberjacks_top': 'Lumberjack\'s Top',
                '/items/cheesemakers_top': 'Cheesemaker\'s Top',
                '/items/crafters_top': 'Crafter\'s Top',
                '/items/tailors_top': 'Tailor\'s Top',
                '/items/chefs_top': 'Chef\'s Top',
                '/items/brewers_top': 'Brewer\'s Top',
                '/items/alchemists_top': 'Alchemist\'s Top',
                '/items/enhancers_top': 'Enhancer\'s Top',
                '/items/gator_vest': 'Gator Vest',
                '/items/turtle_shell_body': 'Turtle Shell Body',
                '/items/colossus_plate_body': 'Colossus Plate Body',
                '/items/demonic_plate_body': 'Demonic Plate Body',
                '/items/anchorbound_plate_body': 'Anchorbound Plate Body',
                '/items/anchorbound_plate_body_refined': 'Anchorbound Plate Body (R)',
                '/items/maelstrom_plate_body': 'Maelstrom Plate Body',
                '/items/maelstrom_plate_body_refined': 'Maelstrom Plate Body (R)',
                '/items/marine_tunic': 'Marine Tunic',
                '/items/revenant_tunic': 'Revenant Tunic',
                '/items/griffin_tunic': 'Griffin Tunic',
                '/items/kraken_tunic': 'Kraken Tunic',
                '/items/kraken_tunic_refined': 'Kraken Tunic (R)',
                '/items/icy_robe_top': 'Icy Robe Top',
                '/items/flaming_robe_top': 'Flaming Robe Top',
                '/items/luna_robe_top': 'Luna Robe Top',
                '/items/royal_water_robe_top': 'Royal Water Robe Top',
                '/items/royal_water_robe_top_refined': 'Royal Water Robe Top (R)',
                '/items/royal_nature_robe_top': 'Royal Nature Robe Top',
                '/items/royal_nature_robe_top_refined': 'Royal Nature Robe Top (R)',
                '/items/royal_fire_robe_top': 'Royal Fire Robe Top',
                '/items/royal_fire_robe_top_refined': 'Royal Fire Robe Top (R)',
                '/items/cheese_plate_body': 'Cheese Plate Body',
                '/items/verdant_plate_body': 'Verdant Plate Body',
                '/items/azure_plate_body': 'Azure Plate Body',
                '/items/burble_plate_body': 'Burble Plate Body',
                '/items/crimson_plate_body': 'Crimson Plate Body',
                '/items/rainbow_plate_body': 'Rainbow Plate Body',
                '/items/holy_plate_body': 'Holy Plate Body',
                '/items/rough_tunic': 'Rough Tunic',
                '/items/reptile_tunic': 'Reptile Tunic',
                '/items/gobo_tunic': 'Gobo Tunic',
                '/items/beast_tunic': 'Beast Tunic',
                '/items/umbral_tunic': 'Umbral Tunic',
                '/items/cotton_robe_top': 'Cotton Robe Top',
                '/items/linen_robe_top': 'Linen Robe Top',
                '/items/bamboo_robe_top': 'Bamboo Robe Top',
                '/items/silk_robe_top': 'Silk Robe Top',
                '/items/radiant_robe_top': 'Radiant Robe Top',
                '/items/dairyhands_bottoms': 'Dairyhand\'s Bottoms',
                '/items/foragers_bottoms': 'Forager\'s Bottoms',
                '/items/lumberjacks_bottoms': 'Lumberjack\'s Bottoms',
                '/items/cheesemakers_bottoms': 'Cheesemaker\'s Bottoms',
                '/items/crafters_bottoms': 'Crafter\'s Bottoms',
                '/items/tailors_bottoms': 'Tailor\'s Bottoms',
                '/items/chefs_bottoms': 'Chef\'s Bottoms',
                '/items/brewers_bottoms': 'Brewer\'s Bottoms',
                '/items/alchemists_bottoms': 'Alchemist\'s Bottoms',
                '/items/enhancers_bottoms': 'Enhancer\'s Bottoms',
                '/items/turtle_shell_legs': 'Turtle Shell Legs',
                '/items/colossus_plate_legs': 'Colossus Plate Legs',
                '/items/demonic_plate_legs': 'Demonic Plate Legs',
                '/items/anchorbound_plate_legs': 'Anchorbound Plate Legs',
                '/items/anchorbound_plate_legs_refined': 'Anchorbound Plate Legs (R)',
                '/items/maelstrom_plate_legs': 'Maelstrom Plate Legs',
                '/items/maelstrom_plate_legs_refined': 'Maelstrom Plate Legs (R)',
                '/items/marine_chaps': 'Marine Chaps',
                '/items/revenant_chaps': 'Revenant Chaps',
                '/items/griffin_chaps': 'Griffin Chaps',
                '/items/kraken_chaps': 'Kraken Chaps',
                '/items/kraken_chaps_refined': 'Kraken Chaps (R)',
                '/items/icy_robe_bottoms': 'Icy Robe Bottoms',
                '/items/flaming_robe_bottoms': 'Flaming Robe Bottoms',
                '/items/luna_robe_bottoms': 'Luna Robe Bottoms',
                '/items/royal_water_robe_bottoms': 'Royal Water Robe Bottoms',
                '/items/royal_water_robe_bottoms_refined': 'Royal Water Robe Bottoms (R)',
                '/items/royal_nature_robe_bottoms': 'Royal Nature Robe Bottoms',
                '/items/royal_nature_robe_bottoms_refined': 'Royal Nature Robe Bottoms (R)',
                '/items/royal_fire_robe_bottoms': 'Royal Fire Robe Bottoms',
                '/items/royal_fire_robe_bottoms_refined': 'Royal Fire Robe Bottoms (R)',
                '/items/cheese_plate_legs': 'Cheese Plate Legs',
                '/items/verdant_plate_legs': 'Verdant Plate Legs',
                '/items/azure_plate_legs': 'Azure Plate Legs',
                '/items/burble_plate_legs': 'Burble Plate Legs',
                '/items/crimson_plate_legs': 'Crimson Plate Legs',
                '/items/rainbow_plate_legs': 'Rainbow Plate Legs',
                '/items/holy_plate_legs': 'Holy Plate Legs',
                '/items/rough_chaps': 'Rough Chaps',
                '/items/reptile_chaps': 'Reptile Chaps',
                '/items/gobo_chaps': 'Gobo Chaps',
                '/items/beast_chaps': 'Beast Chaps',
                '/items/umbral_chaps': 'Umbral Chaps',
                '/items/cotton_robe_bottoms': 'Cotton Robe Bottoms',
                '/items/linen_robe_bottoms': 'Linen Robe Bottoms',
                '/items/bamboo_robe_bottoms': 'Bamboo Robe Bottoms',
                '/items/silk_robe_bottoms': 'Silk Robe Bottoms',
                '/items/radiant_robe_bottoms': 'Radiant Robe Bottoms',
                '/items/enchanted_gloves': 'Enchanted Gloves',
                '/items/pincer_gloves': 'Pincer Gloves',
                '/items/panda_gloves': 'Panda Gloves',
                '/items/magnetic_gloves': 'Magnetic Gloves',
                '/items/dodocamel_gauntlets': 'Dodocamel Gauntlets',
                '/items/dodocamel_gauntlets_refined': 'Dodocamel Gauntlets (R)',
                '/items/sighted_bracers': 'Sighted Bracers',
                '/items/marksman_bracers': 'Marksman Bracers',
                '/items/marksman_bracers_refined': 'Marksman Bracers (R)',
                '/items/chrono_gloves': 'Chrono Gloves',
                '/items/cheese_gauntlets': 'Cheese Gauntlets',
                '/items/verdant_gauntlets': 'Verdant Gauntlets',
                '/items/azure_gauntlets': 'Azure Gauntlets',
                '/items/burble_gauntlets': 'Burble Gauntlets',
                '/items/crimson_gauntlets': 'Crimson Gauntlets',
                '/items/rainbow_gauntlets': 'Rainbow Gauntlets',
                '/items/holy_gauntlets': 'Holy Gauntlets',
                '/items/rough_bracers': 'Rough Bracers',
                '/items/reptile_bracers': 'Reptile Bracers',
                '/items/gobo_bracers': 'Gobo Bracers',
                '/items/beast_bracers': 'Beast Bracers',
                '/items/umbral_bracers': 'Umbral Bracers',
                '/items/cotton_gloves': 'Cotton Gloves',
                '/items/linen_gloves': 'Linen Gloves',
                '/items/bamboo_gloves': 'Bamboo Gloves',
                '/items/silk_gloves': 'Silk Gloves',
                '/items/radiant_gloves': 'Radiant Gloves',
                '/items/collectors_boots': 'Collector\'s Boots',
                '/items/shoebill_shoes': 'Shoebill Shoes',
                '/items/black_bear_shoes': 'Black Bear Shoes',
                '/items/grizzly_bear_shoes': 'Grizzly Bear Shoes',
                '/items/polar_bear_shoes': 'Polar Bear Shoes',
                '/items/pathbreaker_boots': 'Pathbreaker Boots',
                '/items/pathbreaker_boots_refined': 'Pathbreaker Boots (R)',
                '/items/centaur_boots': 'Centaur Boots',
                '/items/pathfinder_boots': 'Pathfinder Boots',
                '/items/pathfinder_boots_refined': 'Pathfinder Boots (R)',
                '/items/sorcerer_boots': 'Sorcerer Boots',
                '/items/pathseeker_boots': 'Pathseeker Boots',
                '/items/pathseeker_boots_refined': 'Pathseeker Boots (R)',
                '/items/cheese_boots': 'Cheese Boots',
                '/items/verdant_boots': 'Verdant Boots',
                '/items/azure_boots': 'Azure Boots',
                '/items/burble_boots': 'Burble Boots',
                '/items/crimson_boots': 'Crimson Boots',
                '/items/rainbow_boots': 'Rainbow Boots',
                '/items/holy_boots': 'Holy Boots',
                '/items/rough_boots': 'Rough Boots',
                '/items/reptile_boots': 'Reptile Boots',
                '/items/gobo_boots': 'Gobo Boots',
                '/items/beast_boots': 'Beast Boots',
                '/items/umbral_boots': 'Umbral Boots',
                '/items/cotton_boots': 'Cotton Boots',
                '/items/linen_boots': 'Linen Boots',
                '/items/bamboo_boots': 'Bamboo Boots',
                '/items/silk_boots': 'Silk Boots',
                '/items/radiant_boots': 'Radiant Boots',
                '/items/small_pouch': 'Small Pouch',
                '/items/medium_pouch': 'Medium Pouch',
                '/items/large_pouch': 'Large Pouch',
                '/items/giant_pouch': 'Giant Pouch',
                '/items/gluttonous_pouch': 'Gluttonous Pouch',
                '/items/guzzling_pouch': 'Guzzling Pouch',
                '/items/necklace_of_efficiency': 'Necklace Of Efficiency',
                '/items/fighter_necklace': 'Fighter Necklace',
                '/items/ranger_necklace': 'Ranger Necklace',
                '/items/wizard_necklace': 'Wizard Necklace',
                '/items/necklace_of_wisdom': 'Necklace Of Wisdom',
                '/items/necklace_of_speed': 'Necklace Of Speed',
                '/items/philosophers_necklace': 'Philosopher\'s Necklace',
                '/items/earrings_of_gathering': 'Earrings Of Gathering',
                '/items/earrings_of_essence_find': 'Earrings Of Essence Find',
                '/items/earrings_of_armor': 'Earrings Of Armor',
                '/items/earrings_of_regeneration': 'Earrings Of Regeneration',
                '/items/earrings_of_resistance': 'Earrings Of Resistance',
                '/items/earrings_of_rare_find': 'Earrings Of Rare Find',
                '/items/earrings_of_critical_strike': 'Earrings Of Critical Strike',
                '/items/philosophers_earrings': 'Philosopher\'s Earrings',
                '/items/ring_of_gathering': 'Ring Of Gathering',
                '/items/ring_of_essence_find': 'Ring Of Essence Find',
                '/items/ring_of_armor': 'Ring Of Armor',
                '/items/ring_of_regeneration': 'Ring Of Regeneration',
                '/items/ring_of_resistance': 'Ring Of Resistance',
                '/items/ring_of_rare_find': 'Ring Of Rare Find',
                '/items/ring_of_critical_strike': 'Ring Of Critical Strike',
                '/items/philosophers_ring': 'Philosopher\'s Ring',
                '/items/trainee_milking_charm': 'Trainee Milking Charm',
                '/items/basic_milking_charm': 'Basic Milking Charm',
                '/items/advanced_milking_charm': 'Advanced Milking Charm',
                '/items/expert_milking_charm': 'Expert Milking Charm',
                '/items/master_milking_charm': 'Master Milking Charm',
                '/items/grandmaster_milking_charm': 'Grandmaster Milking Charm',
                '/items/trainee_foraging_charm': 'Trainee Foraging Charm',
                '/items/basic_foraging_charm': 'Basic Foraging Charm',
                '/items/advanced_foraging_charm': 'Advanced Foraging Charm',
                '/items/expert_foraging_charm': 'Expert Foraging Charm',
                '/items/master_foraging_charm': 'Master Foraging Charm',
                '/items/grandmaster_foraging_charm': 'Grandmaster Foraging Charm',
                '/items/trainee_woodcutting_charm': 'Trainee Woodcutting Charm',
                '/items/basic_woodcutting_charm': 'Basic Woodcutting Charm',
                '/items/advanced_woodcutting_charm': 'Advanced Woodcutting Charm',
                '/items/expert_woodcutting_charm': 'Expert Woodcutting Charm',
                '/items/master_woodcutting_charm': 'Master Woodcutting Charm',
                '/items/grandmaster_woodcutting_charm': 'Grandmaster Woodcutting Charm',
                '/items/trainee_cheesesmithing_charm': 'Trainee Cheesesmithing Charm',
                '/items/basic_cheesesmithing_charm': 'Basic Cheesesmithing Charm',
                '/items/advanced_cheesesmithing_charm': 'Advanced Cheesesmithing Charm',
                '/items/expert_cheesesmithing_charm': 'Expert Cheesesmithing Charm',
                '/items/master_cheesesmithing_charm': 'Master Cheesesmithing Charm',
                '/items/grandmaster_cheesesmithing_charm': 'Grandmaster Cheesesmithing Charm',
                '/items/trainee_crafting_charm': 'Trainee Crafting Charm',
                '/items/basic_crafting_charm': 'Basic Crafting Charm',
                '/items/advanced_crafting_charm': 'Advanced Crafting Charm',
                '/items/expert_crafting_charm': 'Expert Crafting Charm',
                '/items/master_crafting_charm': 'Master Crafting Charm',
                '/items/grandmaster_crafting_charm': 'Grandmaster Crafting Charm',
                '/items/trainee_tailoring_charm': 'Trainee Tailoring Charm',
                '/items/basic_tailoring_charm': 'Basic Tailoring Charm',
                '/items/advanced_tailoring_charm': 'Advanced Tailoring Charm',
                '/items/expert_tailoring_charm': 'Expert Tailoring Charm',
                '/items/master_tailoring_charm': 'Master Tailoring Charm',
                '/items/grandmaster_tailoring_charm': 'Grandmaster Tailoring Charm',
                '/items/trainee_cooking_charm': 'Trainee Cooking Charm',
                '/items/basic_cooking_charm': 'Basic Cooking Charm',
                '/items/advanced_cooking_charm': 'Advanced Cooking Charm',
                '/items/expert_cooking_charm': 'Expert Cooking Charm',
                '/items/master_cooking_charm': 'Master Cooking Charm',
                '/items/grandmaster_cooking_charm': 'Grandmaster Cooking Charm',
                '/items/trainee_brewing_charm': 'Trainee Brewing Charm',
                '/items/basic_brewing_charm': 'Basic Brewing Charm',
                '/items/advanced_brewing_charm': 'Advanced Brewing Charm',
                '/items/expert_brewing_charm': 'Expert Brewing Charm',
                '/items/master_brewing_charm': 'Master Brewing Charm',
                '/items/grandmaster_brewing_charm': 'Grandmaster Brewing Charm',
                '/items/trainee_alchemy_charm': 'Trainee Alchemy Charm',
                '/items/basic_alchemy_charm': 'Basic Alchemy Charm',
                '/items/advanced_alchemy_charm': 'Advanced Alchemy Charm',
                '/items/expert_alchemy_charm': 'Expert Alchemy Charm',
                '/items/master_alchemy_charm': 'Master Alchemy Charm',
                '/items/grandmaster_alchemy_charm': 'Grandmaster Alchemy Charm',
                '/items/trainee_enhancing_charm': 'Trainee Enhancing Charm',
                '/items/basic_enhancing_charm': 'Basic Enhancing Charm',
                '/items/advanced_enhancing_charm': 'Advanced Enhancing Charm',
                '/items/expert_enhancing_charm': 'Expert Enhancing Charm',
                '/items/master_enhancing_charm': 'Master Enhancing Charm',
                '/items/grandmaster_enhancing_charm': 'Grandmaster Enhancing Charm',
                '/items/trainee_stamina_charm': 'Trainee Stamina Charm',
                '/items/basic_stamina_charm': 'Basic Stamina Charm',
                '/items/advanced_stamina_charm': 'Advanced Stamina Charm',
                '/items/expert_stamina_charm': 'Expert Stamina Charm',
                '/items/master_stamina_charm': 'Master Stamina Charm',
                '/items/grandmaster_stamina_charm': 'Grandmaster Stamina Charm',
                '/items/trainee_intelligence_charm': 'Trainee Intelligence Charm',
                '/items/basic_intelligence_charm': 'Basic Intelligence Charm',
                '/items/advanced_intelligence_charm': 'Advanced Intelligence Charm',
                '/items/expert_intelligence_charm': 'Expert Intelligence Charm',
                '/items/master_intelligence_charm': 'Master Intelligence Charm',
                '/items/grandmaster_intelligence_charm': 'Grandmaster Intelligence Charm',
                '/items/trainee_attack_charm': 'Trainee Attack Charm',
                '/items/basic_attack_charm': 'Basic Attack Charm',
                '/items/advanced_attack_charm': 'Advanced Attack Charm',
                '/items/expert_attack_charm': 'Expert Attack Charm',
                '/items/master_attack_charm': 'Master Attack Charm',
                '/items/grandmaster_attack_charm': 'Grandmaster Attack Charm',
                '/items/trainee_defense_charm': 'Trainee Defense Charm',
                '/items/basic_defense_charm': 'Basic Defense Charm',
                '/items/advanced_defense_charm': 'Advanced Defense Charm',
                '/items/expert_defense_charm': 'Expert Defense Charm',
                '/items/master_defense_charm': 'Master Defense Charm',
                '/items/grandmaster_defense_charm': 'Grandmaster Defense Charm',
                '/items/trainee_melee_charm': 'Trainee Melee Charm',
                '/items/basic_melee_charm': 'Basic Melee Charm',
                '/items/advanced_melee_charm': 'Advanced Melee Charm',
                '/items/expert_melee_charm': 'Expert Melee Charm',
                '/items/master_melee_charm': 'Master Melee Charm',
                '/items/grandmaster_melee_charm': 'Grandmaster Melee Charm',
                '/items/trainee_ranged_charm': 'Trainee Ranged Charm',
                '/items/basic_ranged_charm': 'Basic Ranged Charm',
                '/items/advanced_ranged_charm': 'Advanced Ranged Charm',
                '/items/expert_ranged_charm': 'Expert Ranged Charm',
                '/items/master_ranged_charm': 'Master Ranged Charm',
                '/items/grandmaster_ranged_charm': 'Grandmaster Ranged Charm',
                '/items/trainee_magic_charm': 'Trainee Magic Charm',
                '/items/basic_magic_charm': 'Basic Magic Charm',
                '/items/advanced_magic_charm': 'Advanced Magic Charm',
                '/items/expert_magic_charm': 'Expert Magic Charm',
                '/items/master_magic_charm': 'Master Magic Charm',
                '/items/grandmaster_magic_charm': 'Grandmaster Magic Charm',
                '/items/basic_task_badge': 'Basic Task Badge',
                '/items/advanced_task_badge': 'Advanced Task Badge',
                '/items/expert_task_badge': 'Expert Task Badge',
                '/items/celestial_brush': 'Celestial Brush',
                '/items/cheese_brush': 'Cheese Brush',
                '/items/verdant_brush': 'Verdant Brush',
                '/items/azure_brush': 'Azure Brush',
                '/items/burble_brush': 'Burble Brush',
                '/items/crimson_brush': 'Crimson Brush',
                '/items/rainbow_brush': 'Rainbow Brush',
                '/items/holy_brush': 'Holy Brush',
                '/items/celestial_shears': 'Celestial Shears',
                '/items/cheese_shears': 'Cheese Shears',
                '/items/verdant_shears': 'Verdant Shears',
                '/items/azure_shears': 'Azure Shears',
                '/items/burble_shears': 'Burble Shears',
                '/items/crimson_shears': 'Crimson Shears',
                '/items/rainbow_shears': 'Rainbow Shears',
                '/items/holy_shears': 'Holy Shears',
                '/items/celestial_hatchet': 'Celestial Hatchet',
                '/items/cheese_hatchet': 'Cheese Hatchet',
                '/items/verdant_hatchet': 'Verdant Hatchet',
                '/items/azure_hatchet': 'Azure Hatchet',
                '/items/burble_hatchet': 'Burble Hatchet',
                '/items/crimson_hatchet': 'Crimson Hatchet',
                '/items/rainbow_hatchet': 'Rainbow Hatchet',
                '/items/holy_hatchet': 'Holy Hatchet',
                '/items/celestial_hammer': 'Celestial Hammer',
                '/items/cheese_hammer': 'Cheese Hammer',
                '/items/verdant_hammer': 'Verdant Hammer',
                '/items/azure_hammer': 'Azure Hammer',
                '/items/burble_hammer': 'Burble Hammer',
                '/items/crimson_hammer': 'Crimson Hammer',
                '/items/rainbow_hammer': 'Rainbow Hammer',
                '/items/holy_hammer': 'Holy Hammer',
                '/items/celestial_chisel': 'Celestial Chisel',
                '/items/cheese_chisel': 'Cheese Chisel',
                '/items/verdant_chisel': 'Verdant Chisel',
                '/items/azure_chisel': 'Azure Chisel',
                '/items/burble_chisel': 'Burble Chisel',
                '/items/crimson_chisel': 'Crimson Chisel',
                '/items/rainbow_chisel': 'Rainbow Chisel',
                '/items/holy_chisel': 'Holy Chisel',
                '/items/celestial_needle': 'Celestial Needle',
                '/items/cheese_needle': 'Cheese Needle',
                '/items/verdant_needle': 'Verdant Needle',
                '/items/azure_needle': 'Azure Needle',
                '/items/burble_needle': 'Burble Needle',
                '/items/crimson_needle': 'Crimson Needle',
                '/items/rainbow_needle': 'Rainbow Needle',
                '/items/holy_needle': 'Holy Needle',
                '/items/celestial_spatula': 'Celestial Spatula',
                '/items/cheese_spatula': 'Cheese Spatula',
                '/items/verdant_spatula': 'Verdant Spatula',
                '/items/azure_spatula': 'Azure Spatula',
                '/items/burble_spatula': 'Burble Spatula',
                '/items/crimson_spatula': 'Crimson Spatula',
                '/items/rainbow_spatula': 'Rainbow Spatula',
                '/items/holy_spatula': 'Holy Spatula',
                '/items/celestial_pot': 'Celestial Pot',
                '/items/cheese_pot': 'Cheese Pot',
                '/items/verdant_pot': 'Verdant Pot',
                '/items/azure_pot': 'Azure Pot',
                '/items/burble_pot': 'Burble Pot',
                '/items/crimson_pot': 'Crimson Pot',
                '/items/rainbow_pot': 'Rainbow Pot',
                '/items/holy_pot': 'Holy Pot',
                '/items/celestial_alembic': 'Celestial Alembic',
                '/items/cheese_alembic': 'Cheese Alembic',
                '/items/verdant_alembic': 'Verdant Alembic',
                '/items/azure_alembic': 'Azure Alembic',
                '/items/burble_alembic': 'Burble Alembic',
                '/items/crimson_alembic': 'Crimson Alembic',
                '/items/rainbow_alembic': 'Rainbow Alembic',
                '/items/holy_alembic': 'Holy Alembic',
                '/items/celestial_enhancer': 'Celestial Enhancer',
                '/items/cheese_enhancer': 'Cheese Enhancer',
                '/items/verdant_enhancer': 'Verdant Enhancer',
                '/items/azure_enhancer': 'Azure Enhancer',
                '/items/burble_enhancer': 'Burble Enhancer',
                '/items/crimson_enhancer': 'Crimson Enhancer',
                '/items/rainbow_enhancer': 'Rainbow Enhancer',
                '/items/holy_enhancer': 'Holy Enhancer',
                '/items/milk': 'Milk',
                '/items/verdant_milk': 'Verdant Milk',
                '/items/azure_milk': 'Azure Milk',
                '/items/burble_milk': 'Burble Milk',
                '/items/crimson_milk': 'Crimson Milk',
                '/items/rainbow_milk': 'Rainbow Milk',
                '/items/holy_milk': 'Holy Milk',
                '/items/cheese': 'Cheese',
                '/items/verdant_cheese': 'Verdant Cheese',
                '/items/azure_cheese': 'Azure Cheese',
                '/items/burble_cheese': 'Burble Cheese',
                '/items/crimson_cheese': 'Crimson Cheese',
                '/items/rainbow_cheese': 'Rainbow Cheese',
                '/items/holy_cheese': 'Holy Cheese',
                '/items/log': 'Log',
                '/items/birch_log': 'Birch Log',
                '/items/cedar_log': 'Cedar Log',
                '/items/purpleheart_log': 'Purpleheart Log',
                '/items/ginkgo_log': 'Ginkgo Log',
                '/items/redwood_log': 'Redwood Log',
                '/items/arcane_log': 'Arcane Log',
                '/items/lumber': 'Lumber',
                '/items/birch_lumber': 'Birch Lumber',
                '/items/cedar_lumber': 'Cedar Lumber',
                '/items/purpleheart_lumber': 'Purpleheart Lumber',
                '/items/ginkgo_lumber': 'Ginkgo Lumber',
                '/items/redwood_lumber': 'Redwood Lumber',
                '/items/arcane_lumber': 'Arcane Lumber',
                '/items/rough_hide': 'Rough Hide',
                '/items/reptile_hide': 'Reptile Hide',
                '/items/gobo_hide': 'Gobo Hide',
                '/items/beast_hide': 'Beast Hide',
                '/items/umbral_hide': 'Umbral Hide',
                '/items/rough_leather': 'Rough Leather',
                '/items/reptile_leather': 'Reptile Leather',
                '/items/gobo_leather': 'Gobo Leather',
                '/items/beast_leather': 'Beast Leather',
                '/items/umbral_leather': 'Umbral Leather',
                '/items/cotton': 'Cotton',
                '/items/flax': 'Flax',
                '/items/bamboo_branch': 'Bamboo Branch',
                '/items/cocoon': 'Cocoon',
                '/items/radiant_fiber': 'Radiant Fiber',
                '/items/cotton_fabric': 'Cotton Fabric',
                '/items/linen_fabric': 'Linen Fabric',
                '/items/bamboo_fabric': 'Bamboo Fabric',
                '/items/silk_fabric': 'Silk Fabric',
                '/items/radiant_fabric': 'Radiant Fabric',
                '/items/egg': 'Egg',
                '/items/wheat': 'Wheat',
                '/items/sugar': 'Sugar',
                '/items/blueberry': 'Blueberry',
                '/items/blackberry': 'Blackberry',
                '/items/strawberry': 'Strawberry',
                '/items/mooberry': 'Mooberry',
                '/items/marsberry': 'Marsberry',
                '/items/spaceberry': 'Spaceberry',
                '/items/apple': 'Apple',
                '/items/orange': 'Orange',
                '/items/plum': 'Plum',
                '/items/peach': 'Peach',
                '/items/dragon_fruit': 'Dragon Fruit',
                '/items/star_fruit': 'Star Fruit',
                '/items/arabica_coffee_bean': 'Arabica Coffee Bean',
                '/items/robusta_coffee_bean': 'Robusta Coffee Bean',
                '/items/liberica_coffee_bean': 'Liberica Coffee Bean',
                '/items/excelsa_coffee_bean': 'Excelsa Coffee Bean',
                '/items/fieriosa_coffee_bean': 'Fieriosa Coffee Bean',
                '/items/spacia_coffee_bean': 'Spacia Coffee Bean',
                '/items/green_tea_leaf': 'Green Tea Leaf',
                '/items/black_tea_leaf': 'Black Tea Leaf',
                '/items/burble_tea_leaf': 'Burble Tea Leaf',
                '/items/moolong_tea_leaf': 'Moolong Tea Leaf',
                '/items/red_tea_leaf': 'Red Tea Leaf',
                '/items/emp_tea_leaf': 'Emp Tea Leaf',
                '/items/catalyst_of_coinification': 'Catalyst Of Coinification',
                '/items/catalyst_of_decomposition': 'Catalyst Of Decomposition',
                '/items/catalyst_of_transmutation': 'Catalyst Of Transmutation',
                '/items/prime_catalyst': 'Prime Catalyst',
                '/items/snake_fang': 'Snake Fang',
                '/items/shoebill_feather': 'Shoebill Feather',
                '/items/snail_shell': 'Snail Shell',
                '/items/crab_pincer': 'Crab Pincer',
                '/items/turtle_shell': 'Turtle Shell',
                '/items/marine_scale': 'Marine Scale',
                '/items/treant_bark': 'Treant Bark',
                '/items/centaur_hoof': 'Centaur Hoof',
                '/items/luna_wing': 'Luna Wing',
                '/items/gobo_rag': 'Gobo Rag',
                '/items/goggles': 'Goggles',
                '/items/magnifying_glass': 'Magnifying Glass',
                '/items/eye_of_the_watcher': 'Eye Of The Watcher',
                '/items/icy_cloth': 'Icy Cloth',
                '/items/flaming_cloth': 'Flaming Cloth',
                '/items/sorcerers_sole': 'Sorcerer\'s Sole',
                '/items/chrono_sphere': 'Chrono Sphere',
                '/items/frost_sphere': 'Frost Sphere',
                '/items/panda_fluff': 'Panda Fluff',
                '/items/black_bear_fluff': 'Black Bear Fluff',
                '/items/grizzly_bear_fluff': 'Grizzly Bear Fluff',
                '/items/polar_bear_fluff': 'Polar Bear Fluff',
                '/items/red_panda_fluff': 'Red Panda Fluff',
                '/items/magnet': 'Magnet',
                '/items/stalactite_shard': 'Stalactite Shard',
                '/items/living_granite': 'Living Granite',
                '/items/colossus_core': 'Colossus Core',
                '/items/vampire_fang': 'Vampire Fang',
                '/items/werewolf_claw': 'Werewolf Claw',
                '/items/revenant_anima': 'Revenant Anima',
                '/items/soul_fragment': 'Soul Fragment',
                '/items/infernal_ember': 'Infernal Ember',
                '/items/demonic_core': 'Demonic Core',
                '/items/griffin_leather': 'Griffin Leather',
                '/items/manticore_sting': 'Manticore Sting',
                '/items/jackalope_antler': 'Jackalope Antler',
                '/items/dodocamel_plume': 'Dodocamel Plume',
                '/items/griffin_talon': 'Griffin Talon',
                '/items/chimerical_refinement_shard': 'Chimerical Refinement Shard',
                '/items/acrobats_ribbon': 'Acrobat\'s Ribbon',
                '/items/magicians_cloth': 'Magician\'s Cloth',
                '/items/chaotic_chain': 'Chaotic Chain',
                '/items/cursed_ball': 'Cursed Ball',
                '/items/sinister_refinement_shard': 'Sinister Refinement Shard',
                '/items/royal_cloth': 'Royal Cloth',
                '/items/knights_ingot': 'Knight\'s Ingot',
                '/items/bishops_scroll': 'Bishop\'s Scroll',
                '/items/regal_jewel': 'Regal Jewel',
                '/items/sundering_jewel': 'Sundering Jewel',
                '/items/enchanted_refinement_shard': 'Enchanted Refinement Shard',
                '/items/marksman_brooch': 'Marksman Brooch',
                '/items/corsair_crest': 'Corsair Crest',
                '/items/damaged_anchor': 'Damaged Anchor',
                '/items/maelstrom_plating': 'Maelstrom Plating',
                '/items/kraken_leather': 'Kraken Leather',
                '/items/kraken_fang': 'Kraken Fang',
                '/items/pirate_refinement_shard': 'Pirate Refinement Shard',
                '/items/pathbreaker_lodestone': 'Pathbreaker Lodestone',
                '/items/pathfinder_lodestone': 'Pathfinder Lodestone',
                '/items/pathseeker_lodestone': 'Pathseeker Lodestone',
                '/items/labyrinth_refinement_shard': 'Labyrinth Refinement Shard',
                '/items/butter_of_proficiency': 'Butter Of Proficiency',
                '/items/thread_of_expertise': 'Thread Of Expertise',
                '/items/branch_of_insight': 'Branch Of Insight',
                '/items/gluttonous_energy': 'Gluttonous Energy',
                '/items/guzzling_energy': 'Guzzling Energy',
                '/items/milking_essence': 'Milking Essence',
                '/items/foraging_essence': 'Foraging Essence',
                '/items/woodcutting_essence': 'Woodcutting Essence',
                '/items/cheesesmithing_essence': 'Cheesesmithing Essence',
                '/items/crafting_essence': 'Crafting Essence',
                '/items/tailoring_essence': 'Tailoring Essence',
                '/items/cooking_essence': 'Cooking Essence',
                '/items/brewing_essence': 'Brewing Essence',
                '/items/alchemy_essence': 'Alchemy Essence',
                '/items/enhancing_essence': 'Enhancing Essence',
                '/items/swamp_essence': 'Swamp Essence',
                '/items/aqua_essence': 'Aqua Essence',
                '/items/jungle_essence': 'Jungle Essence',
                '/items/gobo_essence': 'Gobo Essence',
                '/items/eyessence': 'Eyessence',
                '/items/sorcerer_essence': 'Sorcerer Essence',
                '/items/bear_essence': 'Bear Essence',
                '/items/golem_essence': 'Golem Essence',
                '/items/twilight_essence': 'Twilight Essence',
                '/items/abyssal_essence': 'Abyssal Essence',
                '/items/chimerical_essence': 'Chimerical Essence',
                '/items/sinister_essence': 'Sinister Essence',
                '/items/enchanted_essence': 'Enchanted Essence',
                '/items/pirate_essence': 'Pirate Essence',
                '/items/labyrinth_essence': 'Labyrinth Essence',
                '/items/task_crystal': 'Task Crystal',
                '/items/star_fragment': 'Star Fragment',
                '/items/pearl': 'Pearl',
                '/items/amber': 'Amber',
                '/items/garnet': 'Garnet',
                '/items/jade': 'Jade',
                '/items/amethyst': 'Amethyst',
                '/items/moonstone': 'Moonstone',
                '/items/sunstone': 'Sunstone',
                '/items/philosophers_stone': 'Philosopher\'s Stone',
                '/items/crushed_pearl': 'Crushed Pearl',
                '/items/crushed_amber': 'Crushed Amber',
                '/items/crushed_garnet': 'Crushed Garnet',
                '/items/crushed_jade': 'Crushed Jade',
                '/items/crushed_amethyst': 'Crushed Amethyst',
                '/items/crushed_moonstone': 'Crushed Moonstone',
                '/items/crushed_sunstone': 'Crushed Sunstone',
                '/items/crushed_philosophers_stone': 'Crushed Philosopher\'s Stone',
                '/items/shard_of_protection': 'Shard Of Protection',
                '/items/mirror_of_protection': 'Mirror Of Protection',
                '/items/philosophers_mirror': 'Philosopher\'s Mirror',
                '/items/basic_torch': 'Basic Torch',
                '/items/advanced_torch': 'Advanced Torch',
                '/items/expert_torch': 'Expert Torch',
                '/items/basic_shroud': 'Basic Shroud',
                '/items/advanced_shroud': 'Advanced Shroud',
                '/items/expert_shroud': 'Expert Shroud',
                '/items/basic_beacon': 'Basic Beacon',
                '/items/advanced_beacon': 'Advanced Beacon',
                '/items/expert_beacon': 'Expert Beacon',
                '/items/basic_food_crate': 'Basic Food Crate',
                '/items/advanced_food_crate': 'Advanced Food Crate',
                '/items/expert_food_crate': 'Expert Food Crate',
                '/items/basic_tea_crate': 'Basic Tea Crate',
                '/items/advanced_tea_crate': 'Advanced Tea Crate',
                '/items/expert_tea_crate': 'Expert Tea Crate',
                '/items/basic_coffee_crate': 'Basic Coffee Crate',
                '/items/advanced_coffee_crate': 'Advanced Coffee Crate',
                '/items/expert_coffee_crate': 'Expert Coffee Crate'
              }
          }
        }
      },
      zh: {
        translation: {
          ...{
            itemNames: {
              '/items/coin': '金币',
              '/items/task_token': '任务代币',
              '/items/labyrinth_token': '迷宫代币',
              '/items/chimerical_token': '奇幻代币',
              '/items/sinister_token': '阴森代币',
              '/items/enchanted_token': '秘法代币',
              '/items/pirate_token': '海盗代币',
              '/items/cowbell': '牛铃',
              '/items/bag_of_10_cowbells': '牛铃袋 (10个)',
              '/items/purples_gift': '小紫牛的礼物',
              '/items/small_meteorite_cache': '小陨石舱',
              '/items/medium_meteorite_cache': '中陨石舱',
              '/items/large_meteorite_cache': '大陨石舱',
              '/items/small_artisans_crate': '小工匠匣',
              '/items/medium_artisans_crate': '中工匠匣',
              '/items/large_artisans_crate': '大工匠匣',
              '/items/small_treasure_chest': '小宝箱',
              '/items/medium_treasure_chest': '中宝箱',
              '/items/large_treasure_chest': '大宝箱',
              '/items/chimerical_chest': '奇幻宝箱',
              '/items/chimerical_refinement_chest': '奇幻精炼宝箱',
              '/items/sinister_chest': '阴森宝箱',
              '/items/sinister_refinement_chest': '阴森精炼宝箱',
              '/items/enchanted_chest': '秘法宝箱',
              '/items/enchanted_refinement_chest': '秘法精炼宝箱',
              '/items/pirate_chest': '海盗宝箱',
              '/items/pirate_refinement_chest': '海盗精炼宝箱',
              '/items/purdoras_box_skilling': '紫多拉之盒（生活）',
              '/items/purdoras_box_combat': '紫多拉之盒（战斗）',
              '/items/labyrinth_refinement_chest': '迷宫精炼宝箱',
              '/items/seal_of_gathering': '采集封印',
              '/items/seal_of_gourmet': '美食封印',
              '/items/seal_of_processing': '加工封印',
              '/items/seal_of_efficiency': '效率封印',
              '/items/seal_of_action_speed': '行动速度封印',
              '/items/seal_of_combat_drop': '战斗掉落封印',
              '/items/seal_of_attack_speed': '攻击速度封印',
              '/items/seal_of_cast_speed': '施法速度封印',
              '/items/seal_of_damage': '伤害封印',
              '/items/seal_of_critical_rate': '暴击率封印',
              '/items/seal_of_wisdom': '经验封印',
              '/items/seal_of_rare_find': '稀有发现封印',
              '/items/blue_key_fragment': '蓝色钥匙碎片',
              '/items/green_key_fragment': '绿色钥匙碎片',
              '/items/purple_key_fragment': '紫色钥匙碎片',
              '/items/white_key_fragment': '白色钥匙碎片',
              '/items/orange_key_fragment': '橙色钥匙碎片',
              '/items/brown_key_fragment': '棕色钥匙碎片',
              '/items/stone_key_fragment': '石头钥匙碎片',
              '/items/dark_key_fragment': '黑暗钥匙碎片',
              '/items/burning_key_fragment': '燃烧钥匙碎片',
              '/items/chimerical_entry_key': '奇幻钥匙',
              '/items/chimerical_chest_key': '奇幻宝箱钥匙',
              '/items/sinister_entry_key': '阴森钥匙',
              '/items/sinister_chest_key': '阴森宝箱钥匙',
              '/items/enchanted_entry_key': '秘法钥匙',
              '/items/enchanted_chest_key': '秘法宝箱钥匙',
              '/items/pirate_entry_key': '海盗钥匙',
              '/items/pirate_chest_key': '海盗宝箱钥匙',
              '/items/donut': '甜甜圈',
              '/items/blueberry_donut': '蓝莓甜甜圈',
              '/items/blackberry_donut': '黑莓甜甜圈',
              '/items/strawberry_donut': '草莓甜甜圈',
              '/items/mooberry_donut': '哞莓甜甜圈',
              '/items/marsberry_donut': '火星莓甜甜圈',
              '/items/spaceberry_donut': '太空莓甜甜圈',
              '/items/cupcake': '纸杯蛋糕',
              '/items/blueberry_cake': '蓝莓蛋糕',
              '/items/blackberry_cake': '黑莓蛋糕',
              '/items/strawberry_cake': '草莓蛋糕',
              '/items/mooberry_cake': '哞莓蛋糕',
              '/items/marsberry_cake': '火星莓蛋糕',
              '/items/spaceberry_cake': '太空莓蛋糕',
              '/items/gummy': '软糖',
              '/items/apple_gummy': '苹果软糖',
              '/items/orange_gummy': '橙子软糖',
              '/items/plum_gummy': '李子软糖',
              '/items/peach_gummy': '桃子软糖',
              '/items/dragon_fruit_gummy': '火龙果软糖',
              '/items/star_fruit_gummy': '杨桃软糖',
              '/items/yogurt': '酸奶',
              '/items/apple_yogurt': '苹果酸奶',
              '/items/orange_yogurt': '橙子酸奶',
              '/items/plum_yogurt': '李子酸奶',
              '/items/peach_yogurt': '桃子酸奶',
              '/items/dragon_fruit_yogurt': '火龙果酸奶',
              '/items/star_fruit_yogurt': '杨桃酸奶',
              '/items/milking_tea': '挤奶茶',
              '/items/foraging_tea': '采摘茶',
              '/items/woodcutting_tea': '伐木茶',
              '/items/cooking_tea': '烹饪茶',
              '/items/brewing_tea': '冲泡茶',
              '/items/alchemy_tea': '炼金茶',
              '/items/enhancing_tea': '强化茶',
              '/items/cheesesmithing_tea': '奶酪锻造茶',
              '/items/crafting_tea': '制作茶',
              '/items/tailoring_tea': '缝纫茶',
              '/items/super_milking_tea': '超级挤奶茶',
              '/items/super_foraging_tea': '超级采摘茶',
              '/items/super_woodcutting_tea': '超级伐木茶',
              '/items/super_cooking_tea': '超级烹饪茶',
              '/items/super_brewing_tea': '超级冲泡茶',
              '/items/super_alchemy_tea': '超级炼金茶',
              '/items/super_enhancing_tea': '超级强化茶',
              '/items/super_cheesesmithing_tea': '超级奶酪锻造茶',
              '/items/super_crafting_tea': '超级制作茶',
              '/items/super_tailoring_tea': '超级缝纫茶',
              '/items/ultra_milking_tea': '究极挤奶茶',
              '/items/ultra_foraging_tea': '究极采摘茶',
              '/items/ultra_woodcutting_tea': '究极伐木茶',
              '/items/ultra_cooking_tea': '究极烹饪茶',
              '/items/ultra_brewing_tea': '究极冲泡茶',
              '/items/ultra_alchemy_tea': '究极炼金茶',
              '/items/ultra_enhancing_tea': '究极强化茶',
              '/items/ultra_cheesesmithing_tea': '究极奶酪锻造茶',
              '/items/ultra_crafting_tea': '究极制作茶',
              '/items/ultra_tailoring_tea': '究极缝纫茶',
              '/items/gathering_tea': '采集茶',
              '/items/gourmet_tea': '美食茶',
              '/items/wisdom_tea': '经验茶',
              '/items/processing_tea': '加工茶',
              '/items/efficiency_tea': '效率茶',
              '/items/artisan_tea': '工匠茶',
              '/items/catalytic_tea': '催化茶',
              '/items/blessed_tea': '福气茶',
              '/items/stamina_coffee': '耐力咖啡',
              '/items/intelligence_coffee': '智力咖啡',
              '/items/defense_coffee': '防御咖啡',
              '/items/attack_coffee': '攻击咖啡',
              '/items/melee_coffee': '近战咖啡',
              '/items/ranged_coffee': '远程咖啡',
              '/items/magic_coffee': '魔法咖啡',
              '/items/super_stamina_coffee': '超级耐力咖啡',
              '/items/super_intelligence_coffee': '超级智力咖啡',
              '/items/super_defense_coffee': '超级防御咖啡',
              '/items/super_attack_coffee': '超级攻击咖啡',
              '/items/super_melee_coffee': '超级近战咖啡',
              '/items/super_ranged_coffee': '超级远程咖啡',
              '/items/super_magic_coffee': '超级魔法咖啡',
              '/items/ultra_stamina_coffee': '究极耐力咖啡',
              '/items/ultra_intelligence_coffee': '究极智力咖啡',
              '/items/ultra_defense_coffee': '究极防御咖啡',
              '/items/ultra_attack_coffee': '究极攻击咖啡',
              '/items/ultra_melee_coffee': '究极近战咖啡',
              '/items/ultra_ranged_coffee': '究极远程咖啡',
              '/items/ultra_magic_coffee': '究极魔法咖啡',
              '/items/wisdom_coffee': '经验咖啡',
              '/items/lucky_coffee': '幸运咖啡',
              '/items/swiftness_coffee': '迅捷咖啡',
              '/items/channeling_coffee': '吟唱咖啡',
              '/items/critical_coffee': '暴击咖啡',
              '/items/poke': '破胆之刺',
              '/items/impale': '透骨之刺',
              '/items/puncture': '破甲之刺',
              '/items/penetrating_strike': '贯心之刺',
              '/items/scratch': '爪影斩',
              '/items/cleave': '分裂斩',
              '/items/maim': '血刃斩',
              '/items/crippling_slash': '致残斩',
              '/items/smack': '重碾',
              '/items/sweep': '重扫',
              '/items/stunning_blow': '重锤',
              '/items/fracturing_impact': '碎裂冲击',
              '/items/shield_bash': '盾击',
              '/items/quick_shot': '快速射击',
              '/items/aqua_arrow': '流水箭',
              '/items/flame_arrow': '烈焰箭',
              '/items/rain_of_arrows': '箭雨',
              '/items/silencing_shot': '沉默之箭',
              '/items/steady_shot': '稳定射击',
              '/items/pestilent_shot': '疫病射击',
              '/items/penetrating_shot': '贯穿射击',
              '/items/water_strike': '流水冲击',
              '/items/ice_spear': '冰枪术',
              '/items/frost_surge': '冰霜爆裂',
              '/items/mana_spring': '法力喷泉',
              '/items/entangle': '缠绕',
              '/items/toxic_pollen': '剧毒粉尘',
              '/items/natures_veil': '自然菌幕',
              '/items/life_drain': '生命吸取',
              '/items/fireball': '火球',
              '/items/flame_blast': '熔岩爆裂',
              '/items/firestorm': '火焰风暴',
              '/items/smoke_burst': '烟爆灭影',
              '/items/minor_heal': '初级自愈术',
              '/items/heal': '自愈术',
              '/items/quick_aid': '快速治疗术',
              '/items/rejuvenate': '群体治疗术',
              '/items/taunt': '嘲讽',
              '/items/provoke': '挑衅',
              '/items/toughness': '坚韧',
              '/items/elusiveness': '闪避',
              '/items/precision': '精确',
              '/items/berserk': '狂暴',
              '/items/elemental_affinity': '元素增幅',
              '/items/frenzy': '狂速',
              '/items/spike_shell': '尖刺防护',
              '/items/retribution': '惩戒',
              '/items/vampirism': '吸血',
              '/items/revive': '复活',
              '/items/insanity': '疯狂',
              '/items/invincible': '无敌',
              '/items/speed_aura': '速度光环',
              '/items/guardian_aura': '守护光环',
              '/items/fierce_aura': '物理光环',
              '/items/critical_aura': '暴击光环',
              '/items/mystic_aura': '元素光环',
              '/items/gobo_stabber': '哥布林长剑',
              '/items/gobo_slasher': '哥布林关刀',
              '/items/gobo_smasher': '哥布林狼牙棒',
              '/items/spiked_bulwark': '尖刺重盾',
              '/items/werewolf_slasher': '狼人关刀',
              '/items/griffin_bulwark': '狮鹫重盾',
              '/items/griffin_bulwark_refined': '狮鹫重盾（精）',
              '/items/gobo_shooter': '哥布林弹弓',
              '/items/vampiric_bow': '吸血弓',
              '/items/cursed_bow': '咒怨之弓',
              '/items/cursed_bow_refined': '咒怨之弓（精）',
              '/items/gobo_boomstick': '哥布林火棍',
              '/items/cheese_bulwark': '奶酪重盾',
              '/items/verdant_bulwark': '翠绿重盾',
              '/items/azure_bulwark': '蔚蓝重盾',
              '/items/burble_bulwark': '深紫重盾',
              '/items/crimson_bulwark': '绛红重盾',
              '/items/rainbow_bulwark': '彩虹重盾',
              '/items/holy_bulwark': '神圣重盾',
              '/items/wooden_bow': '木弓',
              '/items/birch_bow': '桦木弓',
              '/items/cedar_bow': '雪松弓',
              '/items/purpleheart_bow': '紫心弓',
              '/items/ginkgo_bow': '银杏弓',
              '/items/redwood_bow': '红杉弓',
              '/items/arcane_bow': '神秘弓',
              '/items/stalactite_spear': '石钟长枪',
              '/items/granite_bludgeon': '花岗岩大棒',
              '/items/furious_spear': '狂怒长枪',
              '/items/furious_spear_refined': '狂怒长枪（精）',
              '/items/regal_sword': '君王之剑',
              '/items/regal_sword_refined': '君王之剑（精）',
              '/items/chaotic_flail': '混沌连枷',
              '/items/chaotic_flail_refined': '混沌连枷（精）',
              '/items/soul_hunter_crossbow': '灵魂猎手弩',
              '/items/sundering_crossbow': '裂空之弩',
              '/items/sundering_crossbow_refined': '裂空之弩（精）',
              '/items/frost_staff': '冰霜法杖',
              '/items/infernal_battlestaff': '炼狱法杖',
              '/items/jackalope_staff': '鹿角兔之杖',
              '/items/rippling_trident': '涟漪三叉戟',
              '/items/rippling_trident_refined': '涟漪三叉戟（精）',
              '/items/blooming_trident': '绽放三叉戟',
              '/items/blooming_trident_refined': '绽放三叉戟（精）',
              '/items/blazing_trident': '炽焰三叉戟',
              '/items/blazing_trident_refined': '炽焰三叉戟（精）',
              '/items/cheese_sword': '奶酪剑',
              '/items/verdant_sword': '翠绿剑',
              '/items/azure_sword': '蔚蓝剑',
              '/items/burble_sword': '深紫剑',
              '/items/crimson_sword': '绛红剑',
              '/items/rainbow_sword': '彩虹剑',
              '/items/holy_sword': '神圣剑',
              '/items/cheese_spear': '奶酪长枪',
              '/items/verdant_spear': '翠绿长枪',
              '/items/azure_spear': '蔚蓝长枪',
              '/items/burble_spear': '深紫长枪',
              '/items/crimson_spear': '绛红长枪',
              '/items/rainbow_spear': '彩虹长枪',
              '/items/holy_spear': '神圣长枪',
              '/items/cheese_mace': '奶酪钉头锤',
              '/items/verdant_mace': '翠绿钉头锤',
              '/items/azure_mace': '蔚蓝钉头锤',
              '/items/burble_mace': '深紫钉头锤',
              '/items/crimson_mace': '绛红钉头锤',
              '/items/rainbow_mace': '彩虹钉头锤',
              '/items/holy_mace': '神圣钉头锤',
              '/items/wooden_crossbow': '木弩',
              '/items/birch_crossbow': '桦木弩',
              '/items/cedar_crossbow': '雪松弩',
              '/items/purpleheart_crossbow': '紫心弩',
              '/items/ginkgo_crossbow': '银杏弩',
              '/items/redwood_crossbow': '红杉弩',
              '/items/arcane_crossbow': '神秘弩',
              '/items/wooden_water_staff': '木制水法杖',
              '/items/birch_water_staff': '桦木水法杖',
              '/items/cedar_water_staff': '雪松水法杖',
              '/items/purpleheart_water_staff': '紫心水法杖',
              '/items/ginkgo_water_staff': '银杏水法杖',
              '/items/redwood_water_staff': '红杉水法杖',
              '/items/arcane_water_staff': '神秘水法杖',
              '/items/wooden_nature_staff': '木制自然法杖',
              '/items/birch_nature_staff': '桦木自然法杖',
              '/items/cedar_nature_staff': '雪松自然法杖',
              '/items/purpleheart_nature_staff': '紫心自然法杖',
              '/items/ginkgo_nature_staff': '银杏自然法杖',
              '/items/redwood_nature_staff': '红杉自然法杖',
              '/items/arcane_nature_staff': '神秘自然法杖',
              '/items/wooden_fire_staff': '木制火法杖',
              '/items/birch_fire_staff': '桦木火法杖',
              '/items/cedar_fire_staff': '雪松火法杖',
              '/items/purpleheart_fire_staff': '紫心火法杖',
              '/items/ginkgo_fire_staff': '银杏火法杖',
              '/items/redwood_fire_staff': '红杉火法杖',
              '/items/arcane_fire_staff': '神秘火法杖',
              '/items/eye_watch': '掌上监工',
              '/items/snake_fang_dirk': '蛇牙短剑',
              '/items/vision_shield': '视觉盾',
              '/items/gobo_defender': '哥布林防御者',
              '/items/vampire_fang_dirk': '吸血鬼短剑',
              '/items/knights_aegis': '骑士盾',
              '/items/knights_aegis_refined': '骑士盾（精）',
              '/items/treant_shield': '树人盾',
              '/items/manticore_shield': '蝎狮盾',
              '/items/tome_of_healing': '治疗之书',
              '/items/tome_of_the_elements': '元素之书',
              '/items/watchful_relic': '警戒遗物',
              '/items/bishops_codex': '主教法典',
              '/items/bishops_codex_refined': '主教法典（精）',
              '/items/cheese_buckler': '奶酪圆盾',
              '/items/verdant_buckler': '翠绿圆盾',
              '/items/azure_buckler': '蔚蓝圆盾',
              '/items/burble_buckler': '深紫圆盾',
              '/items/crimson_buckler': '绛红圆盾',
              '/items/rainbow_buckler': '彩虹圆盾',
              '/items/holy_buckler': '神圣圆盾',
              '/items/wooden_shield': '木盾',
              '/items/birch_shield': '桦木盾',
              '/items/cedar_shield': '雪松盾',
              '/items/purpleheart_shield': '紫心盾',
              '/items/ginkgo_shield': '银杏盾',
              '/items/redwood_shield': '红杉盾',
              '/items/arcane_shield': '神秘盾',
              '/items/gatherer_cape': '采集者披风',
              '/items/gatherer_cape_refined': '采集者披风（精）',
              '/items/artificer_cape': '工匠披风',
              '/items/artificer_cape_refined': '工匠披风（精）',
              '/items/culinary_cape': '烹饪披风',
              '/items/culinary_cape_refined': '烹饪披风（精）',
              '/items/chance_cape': '机缘披风',
              '/items/chance_cape_refined': '机缘披风（精）',
              '/items/sinister_cape': '阴森斗篷',
              '/items/sinister_cape_refined': '阴森斗篷（精）',
              '/items/chimerical_quiver': '奇幻箭袋',
              '/items/chimerical_quiver_refined': '奇幻箭袋（精）',
              '/items/enchanted_cloak': '秘法披风',
              '/items/enchanted_cloak_refined': '秘法披风（精）',
              '/items/red_culinary_hat': '红色厨师帽',
              '/items/snail_shell_helmet': '蜗牛壳头盔',
              '/items/vision_helmet': '视觉头盔',
              '/items/fluffy_red_hat': '蓬松红帽子',
              '/items/corsair_helmet': '掠夺者头盔',
              '/items/corsair_helmet_refined': '掠夺者头盔（精）',
              '/items/acrobatic_hood': '杂技师兜帽',
              '/items/acrobatic_hood_refined': '杂技师兜帽（精）',
              '/items/magicians_hat': '魔术师帽',
              '/items/magicians_hat_refined': '魔术师帽（精）',
              '/items/cheese_helmet': '奶酪头盔',
              '/items/verdant_helmet': '翠绿头盔',
              '/items/azure_helmet': '蔚蓝头盔',
              '/items/burble_helmet': '深紫头盔',
              '/items/crimson_helmet': '绛红头盔',
              '/items/rainbow_helmet': '彩虹头盔',
              '/items/holy_helmet': '神圣头盔',
              '/items/rough_hood': '粗糙兜帽',
              '/items/reptile_hood': '爬行动物兜帽',
              '/items/gobo_hood': '哥布林兜帽',
              '/items/beast_hood': '野兽兜帽',
              '/items/umbral_hood': '暗影兜帽',
              '/items/cotton_hat': '棉帽',
              '/items/linen_hat': '亚麻帽',
              '/items/bamboo_hat': '竹帽',
              '/items/silk_hat': '丝帽',
              '/items/radiant_hat': '光辉帽',
              '/items/dairyhands_top': '挤奶工上衣',
              '/items/foragers_top': '采摘者上衣',
              '/items/lumberjacks_top': '伐木工上衣',
              '/items/cheesemakers_top': '奶酪师上衣',
              '/items/crafters_top': '工匠上衣',
              '/items/tailors_top': '裁缝上衣',
              '/items/chefs_top': '厨师上衣',
              '/items/brewers_top': '饮品师上衣',
              '/items/alchemists_top': '炼金师上衣',
              '/items/enhancers_top': '强化师上衣',
              '/items/gator_vest': '鳄鱼马甲',
              '/items/turtle_shell_body': '龟壳胸甲',
              '/items/colossus_plate_body': '巨像胸甲',
              '/items/demonic_plate_body': '恶魔胸甲',
              '/items/anchorbound_plate_body': '锚定胸甲',
              '/items/anchorbound_plate_body_refined': '锚定胸甲（精）',
              '/items/maelstrom_plate_body': '怒涛胸甲',
              '/items/maelstrom_plate_body_refined': '怒涛胸甲（精）',
              '/items/marine_tunic': '海洋皮衣',
              '/items/revenant_tunic': '亡灵皮衣',
              '/items/griffin_tunic': '狮鹫皮衣',
              '/items/kraken_tunic': '克拉肯皮衣',
              '/items/kraken_tunic_refined': '克拉肯皮衣（精）',
              '/items/icy_robe_top': '冰霜袍服',
              '/items/flaming_robe_top': '烈焰袍服',
              '/items/luna_robe_top': '月神袍服',
              '/items/royal_water_robe_top': '皇家水系袍服',
              '/items/royal_water_robe_top_refined': '皇家水系袍服（精）',
              '/items/royal_nature_robe_top': '皇家自然系袍服',
              '/items/royal_nature_robe_top_refined': '皇家自然系袍服（精）',
              '/items/royal_fire_robe_top': '皇家火系袍服',
              '/items/royal_fire_robe_top_refined': '皇家火系袍服（精）',
              '/items/cheese_plate_body': '奶酪胸甲',
              '/items/verdant_plate_body': '翠绿胸甲',
              '/items/azure_plate_body': '蔚蓝胸甲',
              '/items/burble_plate_body': '深紫胸甲',
              '/items/crimson_plate_body': '绛红胸甲',
              '/items/rainbow_plate_body': '彩虹胸甲',
              '/items/holy_plate_body': '神圣胸甲',
              '/items/rough_tunic': '粗糙皮衣',
              '/items/reptile_tunic': '爬行动物皮衣',
              '/items/gobo_tunic': '哥布林皮衣',
              '/items/beast_tunic': '野兽皮衣',
              '/items/umbral_tunic': '暗影皮衣',
              '/items/cotton_robe_top': '棉袍服',
              '/items/linen_robe_top': '亚麻袍服',
              '/items/bamboo_robe_top': '竹袍服',
              '/items/silk_robe_top': '丝绸袍服',
              '/items/radiant_robe_top': '光辉袍服',
              '/items/dairyhands_bottoms': '挤奶工下装',
              '/items/foragers_bottoms': '采摘者下装',
              '/items/lumberjacks_bottoms': '伐木工下装',
              '/items/cheesemakers_bottoms': '奶酪师下装',
              '/items/crafters_bottoms': '工匠下装',
              '/items/tailors_bottoms': '裁缝下装',
              '/items/chefs_bottoms': '厨师下装',
              '/items/brewers_bottoms': '饮品师下装',
              '/items/alchemists_bottoms': '炼金师下装',
              '/items/enhancers_bottoms': '强化师下装',
              '/items/turtle_shell_legs': '龟壳腿甲',
              '/items/colossus_plate_legs': '巨像腿甲',
              '/items/demonic_plate_legs': '恶魔腿甲',
              '/items/anchorbound_plate_legs': '锚定腿甲',
              '/items/anchorbound_plate_legs_refined': '锚定腿甲（精）',
              '/items/maelstrom_plate_legs': '怒涛腿甲',
              '/items/maelstrom_plate_legs_refined': '怒涛腿甲（精）',
              '/items/marine_chaps': '航海皮裤',
              '/items/revenant_chaps': '亡灵皮裤',
              '/items/griffin_chaps': '狮鹫皮裤',
              '/items/kraken_chaps': '克拉肯皮裤',
              '/items/kraken_chaps_refined': '克拉肯皮裤（精）',
              '/items/icy_robe_bottoms': '冰霜袍裙',
              '/items/flaming_robe_bottoms': '烈焰袍裙',
              '/items/luna_robe_bottoms': '月神袍裙',
              '/items/royal_water_robe_bottoms': '皇家水系袍裙',
              '/items/royal_water_robe_bottoms_refined': '皇家水系袍裙（精）',
              '/items/royal_nature_robe_bottoms': '皇家自然系袍裙',
              '/items/royal_nature_robe_bottoms_refined': '皇家自然系袍裙（精）',
              '/items/royal_fire_robe_bottoms': '皇家火系袍裙',
              '/items/royal_fire_robe_bottoms_refined': '皇家火系袍裙（精）',
              '/items/cheese_plate_legs': '奶酪腿甲',
              '/items/verdant_plate_legs': '翠绿腿甲',
              '/items/azure_plate_legs': '蔚蓝腿甲',
              '/items/burble_plate_legs': '深紫腿甲',
              '/items/crimson_plate_legs': '绛红腿甲',
              '/items/rainbow_plate_legs': '彩虹腿甲',
              '/items/holy_plate_legs': '神圣腿甲',
              '/items/rough_chaps': '粗糙皮裤',
              '/items/reptile_chaps': '爬行动物皮裤',
              '/items/gobo_chaps': '哥布林皮裤',
              '/items/beast_chaps': '野兽皮裤',
              '/items/umbral_chaps': '暗影皮裤',
              '/items/cotton_robe_bottoms': '棉袍裙',
              '/items/linen_robe_bottoms': '亚麻袍裙',
              '/items/bamboo_robe_bottoms': '竹袍裙',
              '/items/silk_robe_bottoms': '丝绸袍裙',
              '/items/radiant_robe_bottoms': '光辉袍裙',
              '/items/enchanted_gloves': '附魔手套',
              '/items/pincer_gloves': '蟹钳手套',
              '/items/panda_gloves': '熊猫手套',
              '/items/magnetic_gloves': '磁力手套',
              '/items/dodocamel_gauntlets': '渡渡驼护手',
              '/items/dodocamel_gauntlets_refined': '渡渡驼护手（精）',
              '/items/sighted_bracers': '瞄准护腕',
              '/items/marksman_bracers': '神射护腕',
              '/items/marksman_bracers_refined': '神射护腕（精）',
              '/items/chrono_gloves': '时空手套',
              '/items/cheese_gauntlets': '奶酪护手',
              '/items/verdant_gauntlets': '翠绿护手',
              '/items/azure_gauntlets': '蔚蓝护手',
              '/items/burble_gauntlets': '深紫护手',
              '/items/crimson_gauntlets': '绛红护手',
              '/items/rainbow_gauntlets': '彩虹护手',
              '/items/holy_gauntlets': '神圣护手',
              '/items/rough_bracers': '粗糙护腕',
              '/items/reptile_bracers': '爬行动物护腕',
              '/items/gobo_bracers': '哥布林护腕',
              '/items/beast_bracers': '野兽护腕',
              '/items/umbral_bracers': '暗影护腕',
              '/items/cotton_gloves': '棉手套',
              '/items/linen_gloves': '亚麻手套',
              '/items/bamboo_gloves': '竹手套',
              '/items/silk_gloves': '丝手套',
              '/items/radiant_gloves': '光辉手套',
              '/items/collectors_boots': '收藏家靴',
              '/items/shoebill_shoes': '鲸头鹳鞋',
              '/items/black_bear_shoes': '黑熊鞋',
              '/items/grizzly_bear_shoes': '棕熊鞋',
              '/items/polar_bear_shoes': '北极熊鞋',
              '/items/pathbreaker_boots': '开路者靴',
              '/items/pathbreaker_boots_refined': '开路者靴（精）',
              '/items/centaur_boots': '半人马靴',
              '/items/pathfinder_boots': '探路者靴',
              '/items/pathfinder_boots_refined': '探路者靴（精）',
              '/items/sorcerer_boots': '巫师靴',
              '/items/pathseeker_boots': '寻路者靴',
              '/items/pathseeker_boots_refined': '寻路者靴（精）',
              '/items/cheese_boots': '奶酪靴',
              '/items/verdant_boots': '翠绿靴',
              '/items/azure_boots': '蔚蓝靴',
              '/items/burble_boots': '深紫靴',
              '/items/crimson_boots': '绛红靴',
              '/items/rainbow_boots': '彩虹靴',
              '/items/holy_boots': '神圣靴',
              '/items/rough_boots': '粗糙靴',
              '/items/reptile_boots': '爬行动物靴',
              '/items/gobo_boots': '哥布林靴',
              '/items/beast_boots': '野兽靴',
              '/items/umbral_boots': '暗影靴',
              '/items/cotton_boots': '棉靴',
              '/items/linen_boots': '亚麻靴',
              '/items/bamboo_boots': '竹靴',
              '/items/silk_boots': '丝靴',
              '/items/radiant_boots': '光辉靴',
              '/items/small_pouch': '小袋子',
              '/items/medium_pouch': '中袋子',
              '/items/large_pouch': '大袋子',
              '/items/giant_pouch': '巨大袋子',
              '/items/gluttonous_pouch': '贪食之袋',
              '/items/guzzling_pouch': '暴饮之囊',
              '/items/necklace_of_efficiency': '效率项链',
              '/items/fighter_necklace': '战士项链',
              '/items/ranger_necklace': '射手项链',
              '/items/wizard_necklace': '巫师项链',
              '/items/necklace_of_wisdom': '经验项链',
              '/items/necklace_of_speed': '速度项链',
              '/items/philosophers_necklace': '贤者项链',
              '/items/earrings_of_gathering': '采集耳环',
              '/items/earrings_of_essence_find': '精华发现耳环',
              '/items/earrings_of_armor': '护甲耳环',
              '/items/earrings_of_regeneration': '恢复耳环',
              '/items/earrings_of_resistance': '抗性耳环',
              '/items/earrings_of_rare_find': '稀有发现耳环',
              '/items/earrings_of_critical_strike': '暴击耳环',
              '/items/philosophers_earrings': '贤者耳环',
              '/items/ring_of_gathering': '采集戒指',
              '/items/ring_of_essence_find': '精华发现戒指',
              '/items/ring_of_armor': '护甲戒指',
              '/items/ring_of_regeneration': '恢复戒指',
              '/items/ring_of_resistance': '抗性戒指',
              '/items/ring_of_rare_find': '稀有发现戒指',
              '/items/ring_of_critical_strike': '暴击戒指',
              '/items/philosophers_ring': '贤者戒指',
              '/items/trainee_milking_charm': '实习挤奶护符',
              '/items/basic_milking_charm': '基础挤奶护符',
              '/items/advanced_milking_charm': '高级挤奶护符',
              '/items/expert_milking_charm': '专家挤奶护符',
              '/items/master_milking_charm': '大师挤奶护符',
              '/items/grandmaster_milking_charm': '宗师挤奶护符',
              '/items/trainee_foraging_charm': '实习采摘护符',
              '/items/basic_foraging_charm': '基础采摘护符',
              '/items/advanced_foraging_charm': '高级采摘护符',
              '/items/expert_foraging_charm': '专家采摘护符',
              '/items/master_foraging_charm': '大师采摘护符',
              '/items/grandmaster_foraging_charm': '宗师采摘护符',
              '/items/trainee_woodcutting_charm': '实习伐木护符',
              '/items/basic_woodcutting_charm': '基础伐木护符',
              '/items/advanced_woodcutting_charm': '高级伐木护符',
              '/items/expert_woodcutting_charm': '专家伐木护符',
              '/items/master_woodcutting_charm': '大师伐木护符',
              '/items/grandmaster_woodcutting_charm': '宗师伐木护符',
              '/items/trainee_cheesesmithing_charm': '实习奶酪锻造护符',
              '/items/basic_cheesesmithing_charm': '基础奶酪锻造护符',
              '/items/advanced_cheesesmithing_charm': '高级奶酪锻造护符',
              '/items/expert_cheesesmithing_charm': '专家奶酪锻造护符',
              '/items/master_cheesesmithing_charm': '大师奶酪锻造护符',
              '/items/grandmaster_cheesesmithing_charm': '宗师奶酪锻造护符',
              '/items/trainee_crafting_charm': '实习制作护符',
              '/items/basic_crafting_charm': '基础制作护符',
              '/items/advanced_crafting_charm': '高级制作护符',
              '/items/expert_crafting_charm': '专家制作护符',
              '/items/master_crafting_charm': '大师制作护符',
              '/items/grandmaster_crafting_charm': '宗师制作护符',
              '/items/trainee_tailoring_charm': '实习缝纫护符',
              '/items/basic_tailoring_charm': '基础缝纫护符',
              '/items/advanced_tailoring_charm': '高级缝纫护符',
              '/items/expert_tailoring_charm': '专家缝纫护符',
              '/items/master_tailoring_charm': '大师缝纫护符',
              '/items/grandmaster_tailoring_charm': '宗师缝纫护符',
              '/items/trainee_cooking_charm': '实习烹饪护符',
              '/items/basic_cooking_charm': '基础烹饪护符',
              '/items/advanced_cooking_charm': '高级烹饪护符',
              '/items/expert_cooking_charm': '专家烹饪护符',
              '/items/master_cooking_charm': '大师烹饪护符',
              '/items/grandmaster_cooking_charm': '宗师烹饪护符',
              '/items/trainee_brewing_charm': '实习冲泡护符',
              '/items/basic_brewing_charm': '基础冲泡护符',
              '/items/advanced_brewing_charm': '高级冲泡护符',
              '/items/expert_brewing_charm': '专家冲泡护符',
              '/items/master_brewing_charm': '大师冲泡护符',
              '/items/grandmaster_brewing_charm': '宗师冲泡护符',
              '/items/trainee_alchemy_charm': '实习炼金护符',
              '/items/basic_alchemy_charm': '基础炼金护符',
              '/items/advanced_alchemy_charm': '高级炼金护符',
              '/items/expert_alchemy_charm': '专家炼金护符',
              '/items/master_alchemy_charm': '大师炼金护符',
              '/items/grandmaster_alchemy_charm': '宗师炼金护符',
              '/items/trainee_enhancing_charm': '实习强化护符',
              '/items/basic_enhancing_charm': '基础强化护符',
              '/items/advanced_enhancing_charm': '高级强化护符',
              '/items/expert_enhancing_charm': '专家强化护符',
              '/items/master_enhancing_charm': '大师强化护符',
              '/items/grandmaster_enhancing_charm': '宗师强化护符',
              '/items/trainee_stamina_charm': '实习耐力护符',
              '/items/basic_stamina_charm': '基础耐力护符',
              '/items/advanced_stamina_charm': '高级耐力护符',
              '/items/expert_stamina_charm': '专家耐力护符',
              '/items/master_stamina_charm': '大师耐力护符',
              '/items/grandmaster_stamina_charm': '宗师耐力护符',
              '/items/trainee_intelligence_charm': '实习智力护符',
              '/items/basic_intelligence_charm': '基础智力护符',
              '/items/advanced_intelligence_charm': '高级智力护符',
              '/items/expert_intelligence_charm': '专家智力护符',
              '/items/master_intelligence_charm': '大师智力护符',
              '/items/grandmaster_intelligence_charm': '宗师智力护符',
              '/items/trainee_attack_charm': '实习攻击护符',
              '/items/basic_attack_charm': '基础攻击护符',
              '/items/advanced_attack_charm': '高级攻击护符',
              '/items/expert_attack_charm': '专家攻击护符',
              '/items/master_attack_charm': '大师攻击护符',
              '/items/grandmaster_attack_charm': '宗师攻击护符',
              '/items/trainee_defense_charm': '实习防御护符',
              '/items/basic_defense_charm': '基础防御护符',
              '/items/advanced_defense_charm': '高级防御护符',
              '/items/expert_defense_charm': '专家防御护符',
              '/items/master_defense_charm': '大师防御护符',
              '/items/grandmaster_defense_charm': '宗师防御护符',
              '/items/trainee_melee_charm': '实习近战护符',
              '/items/basic_melee_charm': '基础近战护符',
              '/items/advanced_melee_charm': '高级近战护符',
              '/items/expert_melee_charm': '专家近战护符',
              '/items/master_melee_charm': '大师近战护符',
              '/items/grandmaster_melee_charm': '宗师近战护符',
              '/items/trainee_ranged_charm': '实习远程护符',
              '/items/basic_ranged_charm': '基础远程护符',
              '/items/advanced_ranged_charm': '高级远程护符',
              '/items/expert_ranged_charm': '专家远程护符',
              '/items/master_ranged_charm': '大师远程护符',
              '/items/grandmaster_ranged_charm': '宗师远程护符',
              '/items/trainee_magic_charm': '实习魔法护符',
              '/items/basic_magic_charm': '基础魔法护符',
              '/items/advanced_magic_charm': '高级魔法护符',
              '/items/expert_magic_charm': '专家魔法护符',
              '/items/master_magic_charm': '大师魔法护符',
              '/items/grandmaster_magic_charm': '宗师魔法护符',
              '/items/basic_task_badge': '基础任务徽章',
              '/items/advanced_task_badge': '高级任务徽章',
              '/items/expert_task_badge': '专家任务徽章',
              '/items/celestial_brush': '星空刷子',
              '/items/cheese_brush': '奶酪刷子',
              '/items/verdant_brush': '翠绿刷子',
              '/items/azure_brush': '蔚蓝刷子',
              '/items/burble_brush': '深紫刷子',
              '/items/crimson_brush': '绛红刷子',
              '/items/rainbow_brush': '彩虹刷子',
              '/items/holy_brush': '神圣刷子',
              '/items/celestial_shears': '星空剪刀',
              '/items/cheese_shears': '奶酪剪刀',
              '/items/verdant_shears': '翠绿剪刀',
              '/items/azure_shears': '蔚蓝剪刀',
              '/items/burble_shears': '深紫剪刀',
              '/items/crimson_shears': '绛红剪刀',
              '/items/rainbow_shears': '彩虹剪刀',
              '/items/holy_shears': '神圣剪刀',
              '/items/celestial_hatchet': '星空斧头',
              '/items/cheese_hatchet': '奶酪斧头',
              '/items/verdant_hatchet': '翠绿斧头',
              '/items/azure_hatchet': '蔚蓝斧头',
              '/items/burble_hatchet': '深紫斧头',
              '/items/crimson_hatchet': '绛红斧头',
              '/items/rainbow_hatchet': '彩虹斧头',
              '/items/holy_hatchet': '神圣斧头',
              '/items/celestial_hammer': '星空锤子',
              '/items/cheese_hammer': '奶酪锤子',
              '/items/verdant_hammer': '翠绿锤子',
              '/items/azure_hammer': '蔚蓝锤子',
              '/items/burble_hammer': '深紫锤子',
              '/items/crimson_hammer': '绛红锤子',
              '/items/rainbow_hammer': '彩虹锤子',
              '/items/holy_hammer': '神圣锤子',
              '/items/celestial_chisel': '星空凿子',
              '/items/cheese_chisel': '奶酪凿子',
              '/items/verdant_chisel': '翠绿凿子',
              '/items/azure_chisel': '蔚蓝凿子',
              '/items/burble_chisel': '深紫凿子',
              '/items/crimson_chisel': '绛红凿子',
              '/items/rainbow_chisel': '彩虹凿子',
              '/items/holy_chisel': '神圣凿子',
              '/items/celestial_needle': '星空针',
              '/items/cheese_needle': '奶酪针',
              '/items/verdant_needle': '翠绿针',
              '/items/azure_needle': '蔚蓝针',
              '/items/burble_needle': '深紫针',
              '/items/crimson_needle': '绛红针',
              '/items/rainbow_needle': '彩虹针',
              '/items/holy_needle': '神圣针',
              '/items/celestial_spatula': '星空锅铲',
              '/items/cheese_spatula': '奶酪锅铲',
              '/items/verdant_spatula': '翠绿锅铲',
              '/items/azure_spatula': '蔚蓝锅铲',
              '/items/burble_spatula': '深紫锅铲',
              '/items/crimson_spatula': '绛红锅铲',
              '/items/rainbow_spatula': '彩虹锅铲',
              '/items/holy_spatula': '神圣锅铲',
              '/items/celestial_pot': '星空壶',
              '/items/cheese_pot': '奶酪壶',
              '/items/verdant_pot': '翠绿壶',
              '/items/azure_pot': '蔚蓝壶',
              '/items/burble_pot': '深紫壶',
              '/items/crimson_pot': '绛红壶',
              '/items/rainbow_pot': '彩虹壶',
              '/items/holy_pot': '神圣壶',
              '/items/celestial_alembic': '星空蒸馏器',
              '/items/cheese_alembic': '奶酪蒸馏器',
              '/items/verdant_alembic': '翠绿蒸馏器',
              '/items/azure_alembic': '蔚蓝蒸馏器',
              '/items/burble_alembic': '深紫蒸馏器',
              '/items/crimson_alembic': '绛红蒸馏器',
              '/items/rainbow_alembic': '彩虹蒸馏器',
              '/items/holy_alembic': '神圣蒸馏器',
              '/items/celestial_enhancer': '星空强化器',
              '/items/cheese_enhancer': '奶酪强化器',
              '/items/verdant_enhancer': '翠绿强化器',
              '/items/azure_enhancer': '蔚蓝强化器',
              '/items/burble_enhancer': '深紫强化器',
              '/items/crimson_enhancer': '绛红强化器',
              '/items/rainbow_enhancer': '彩虹强化器',
              '/items/holy_enhancer': '神圣强化器',
              '/items/milk': '牛奶',
              '/items/verdant_milk': '翠绿牛奶',
              '/items/azure_milk': '蔚蓝牛奶',
              '/items/burble_milk': '深紫牛奶',
              '/items/crimson_milk': '绛红牛奶',
              '/items/rainbow_milk': '彩虹牛奶',
              '/items/holy_milk': '神圣牛奶',
              '/items/cheese': '奶酪',
              '/items/verdant_cheese': '翠绿奶酪',
              '/items/azure_cheese': '蔚蓝奶酪',
              '/items/burble_cheese': '深紫奶酪',
              '/items/crimson_cheese': '绛红奶酪',
              '/items/rainbow_cheese': '彩虹奶酪',
              '/items/holy_cheese': '神圣奶酪',
              '/items/log': '原木',
              '/items/birch_log': '白桦原木',
              '/items/cedar_log': '雪松原木',
              '/items/purpleheart_log': '紫心原木',
              '/items/ginkgo_log': '银杏原木',
              '/items/redwood_log': '红杉原木',
              '/items/arcane_log': '神秘原木',
              '/items/lumber': '木板',
              '/items/birch_lumber': '白桦木板',
              '/items/cedar_lumber': '雪松木板',
              '/items/purpleheart_lumber': '紫心木板',
              '/items/ginkgo_lumber': '银杏木板',
              '/items/redwood_lumber': '红杉木板',
              '/items/arcane_lumber': '神秘木板',
              '/items/rough_hide': '粗糙兽皮',
              '/items/reptile_hide': '爬行动物皮',
              '/items/gobo_hide': '哥布林皮',
              '/items/beast_hide': '野兽皮',
              '/items/umbral_hide': '暗影皮',
              '/items/rough_leather': '粗糙皮革',
              '/items/reptile_leather': '爬行动物皮革',
              '/items/gobo_leather': '哥布林皮革',
              '/items/beast_leather': '野兽皮革',
              '/items/umbral_leather': '暗影皮革',
              '/items/cotton': '棉花',
              '/items/flax': '亚麻',
              '/items/bamboo_branch': '竹子',
              '/items/cocoon': '蚕茧',
              '/items/radiant_fiber': '光辉纤维',
              '/items/cotton_fabric': '棉花布料',
              '/items/linen_fabric': '亚麻布料',
              '/items/bamboo_fabric': '竹子布料',
              '/items/silk_fabric': '丝绸',
              '/items/radiant_fabric': '光辉布料',
              '/items/egg': '鸡蛋',
              '/items/wheat': '小麦',
              '/items/sugar': '糖',
              '/items/blueberry': '蓝莓',
              '/items/blackberry': '黑莓',
              '/items/strawberry': '草莓',
              '/items/mooberry': '哞莓',
              '/items/marsberry': '火星莓',
              '/items/spaceberry': '太空莓',
              '/items/apple': '苹果',
              '/items/orange': '橙子',
              '/items/plum': '李子',
              '/items/peach': '桃子',
              '/items/dragon_fruit': '火龙果',
              '/items/star_fruit': '杨桃',
              '/items/arabica_coffee_bean': '低级咖啡豆',
              '/items/robusta_coffee_bean': '中级咖啡豆',
              '/items/liberica_coffee_bean': '高级咖啡豆',
              '/items/excelsa_coffee_bean': '特级咖啡豆',
              '/items/fieriosa_coffee_bean': '火山咖啡豆',
              '/items/spacia_coffee_bean': '太空咖啡豆',
              '/items/green_tea_leaf': '绿茶叶',
              '/items/black_tea_leaf': '黑茶叶',
              '/items/burble_tea_leaf': '紫茶叶',
              '/items/moolong_tea_leaf': '哞龙茶叶',
              '/items/red_tea_leaf': '红茶叶',
              '/items/emp_tea_leaf': '虚空茶叶',
              '/items/catalyst_of_coinification': '点金催化剂',
              '/items/catalyst_of_decomposition': '分解催化剂',
              '/items/catalyst_of_transmutation': '转化催化剂',
              '/items/prime_catalyst': '至高催化剂',
              '/items/snake_fang': '蛇牙',
              '/items/shoebill_feather': '鲸头鹳羽毛',
              '/items/snail_shell': '蜗牛壳',
              '/items/crab_pincer': '蟹钳',
              '/items/turtle_shell': '乌龟壳',
              '/items/marine_scale': '海洋鳞片',
              '/items/treant_bark': '树皮',
              '/items/centaur_hoof': '半人马蹄',
              '/items/luna_wing': '月神翼',
              '/items/gobo_rag': '哥布林抹布',
              '/items/goggles': '护目镜',
              '/items/magnifying_glass': '放大镜',
              '/items/eye_of_the_watcher': '观察者之眼',
              '/items/icy_cloth': '冰霜织物',
              '/items/flaming_cloth': '烈焰织物',
              '/items/sorcerers_sole': '魔法师鞋底',
              '/items/chrono_sphere': '时空球',
              '/items/frost_sphere': '冰霜球',
              '/items/panda_fluff': '熊猫绒',
              '/items/black_bear_fluff': '黑熊绒',
              '/items/grizzly_bear_fluff': '棕熊绒',
              '/items/polar_bear_fluff': '北极熊绒',
              '/items/red_panda_fluff': '小熊猫绒',
              '/items/magnet': '磁铁',
              '/items/stalactite_shard': '钟乳石碎片',
              '/items/living_granite': '花岗岩',
              '/items/colossus_core': '巨像核心',
              '/items/vampire_fang': '吸血鬼之牙',
              '/items/werewolf_claw': '狼人之爪',
              '/items/revenant_anima': '亡者之魂',
              '/items/soul_fragment': '灵魂碎片',
              '/items/infernal_ember': '地狱余烬',
              '/items/demonic_core': '恶魔核心',
              '/items/griffin_leather': '狮鹫之皮',
              '/items/manticore_sting': '蝎狮之刺',
              '/items/jackalope_antler': '鹿角兔之角',
              '/items/dodocamel_plume': '渡渡驼之翎',
              '/items/griffin_talon': '狮鹫之爪',
              '/items/chimerical_refinement_shard': '奇幻精炼碎片',
              '/items/acrobats_ribbon': '杂技师彩带',
              '/items/magicians_cloth': '魔术师织物',
              '/items/chaotic_chain': '混沌锁链',
              '/items/cursed_ball': '诅咒之球',
              '/items/sinister_refinement_shard': '阴森精炼碎片',
              '/items/royal_cloth': '皇家织物',
              '/items/knights_ingot': '骑士之锭',
              '/items/bishops_scroll': '主教卷轴',
              '/items/regal_jewel': '君王宝石',
              '/items/sundering_jewel': '裂空宝石',
              '/items/enchanted_refinement_shard': '秘法精炼碎片',
              '/items/marksman_brooch': '神射胸针',
              '/items/corsair_crest': '掠夺者徽章',
              '/items/damaged_anchor': '破损船锚',
              '/items/maelstrom_plating': '怒涛甲片',
              '/items/kraken_leather': '克拉肯皮革',
              '/items/kraken_fang': '克拉肯之牙',
              '/items/pirate_refinement_shard': '海盗精炼碎片',
              '/items/pathbreaker_lodestone': '开路者磁石',
              '/items/pathfinder_lodestone': '探路者磁石',
              '/items/pathseeker_lodestone': '寻路者磁石',
              '/items/labyrinth_refinement_shard': '迷宫精炼碎片',
              '/items/butter_of_proficiency': '精通之油',
              '/items/thread_of_expertise': '专精之线',
              '/items/branch_of_insight': '洞察之枝',
              '/items/gluttonous_energy': '贪食能量',
              '/items/guzzling_energy': '暴饮能量',
              '/items/milking_essence': '挤奶精华',
              '/items/foraging_essence': '采摘精华',
              '/items/woodcutting_essence': '伐木精华',
              '/items/cheesesmithing_essence': '奶酪锻造精华',
              '/items/crafting_essence': '制作精华',
              '/items/tailoring_essence': '缝纫精华',
              '/items/cooking_essence': '烹饪精华',
              '/items/brewing_essence': '冲泡精华',
              '/items/alchemy_essence': '炼金精华',
              '/items/enhancing_essence': '强化精华',
              '/items/swamp_essence': '沼泽精华',
              '/items/aqua_essence': '海洋精华',
              '/items/jungle_essence': '丛林精华',
              '/items/gobo_essence': '哥布林精华',
              '/items/eyessence': '眼精华',
              '/items/sorcerer_essence': '法师精华',
              '/items/bear_essence': '熊熊精华',
              '/items/golem_essence': '魔像精华',
              '/items/twilight_essence': '暮光精华',
              '/items/abyssal_essence': '地狱精华',
              '/items/chimerical_essence': '奇幻精华',
              '/items/sinister_essence': '阴森精华',
              '/items/enchanted_essence': '秘法精华',
              '/items/pirate_essence': '海盗精华',
              '/items/labyrinth_essence': '迷宫精华',
              '/items/task_crystal': '任务水晶',
              '/items/star_fragment': '星光碎片',
              '/items/pearl': '珍珠',
              '/items/amber': '琥珀',
              '/items/garnet': '石榴石',
              '/items/jade': '翡翠',
              '/items/amethyst': '紫水晶',
              '/items/moonstone': '月亮石',
              '/items/sunstone': '太阳石',
              '/items/philosophers_stone': '贤者之石',
              '/items/crushed_pearl': '珍珠碎片',
              '/items/crushed_amber': '琥珀碎片',
              '/items/crushed_garnet': '石榴石碎片',
              '/items/crushed_jade': '翡翠碎片',
              '/items/crushed_amethyst': '紫水晶碎片',
              '/items/crushed_moonstone': '月亮石碎片',
              '/items/crushed_sunstone': '太阳石碎片',
              '/items/crushed_philosophers_stone': '贤者之石碎片',
              '/items/shard_of_protection': '保护碎片',
              '/items/mirror_of_protection': '保护之镜',
              '/items/philosophers_mirror': '贤者之镜',
              '/items/basic_torch': '基础火炬',
              '/items/advanced_torch': '进阶火炬',
              '/items/expert_torch': '专家火炬',
              '/items/basic_shroud': '基础斗篷',
              '/items/advanced_shroud': '进阶斗篷',
              '/items/expert_shroud': '专家斗篷',
              '/items/basic_beacon': '基础信标',
              '/items/advanced_beacon': '进阶信标',
              '/items/expert_beacon': '专家信标',
              '/items/basic_food_crate': '基础食物箱',
              '/items/advanced_food_crate': '进阶食物箱',
              '/items/expert_food_crate': '专家食物箱',
              '/items/basic_tea_crate': '基础茶叶箱',
              '/items/advanced_tea_crate': '进阶茶叶箱',
              '/items/expert_tea_crate': '专家茶叶箱',
              '/items/basic_coffee_crate': '基础咖啡箱',
              '/items/advanced_coffee_crate': '进阶咖啡箱',
              '/items/expert_coffee_crate': '专家咖啡箱'
            }
          }
        }
      }
    };
    mwi.itemNameToHridDict = {};
    Object.entries(mwi.lang.en.translation.itemNames).forEach(([k, v]) => { mwi.itemNameToHridDict[v] = k });
    Object.entries(mwi.lang.zh.translation.itemNames).forEach(([k, v]) => { mwi.itemNameToHridDict[v] = k });
  }

  

  function injectedInit() {
    /*注入成功，使用游戏数据*/
    mwi.itemNameToHridDict = {};
    Object.entries(mwi.lang.en.translation.itemNames).forEach(([k, v]) => { mwi.itemNameToHridDict[v] = k });
    Object.entries(mwi.lang.zh.translation.itemNames).forEach(([k, v]) => { mwi.itemNameToHridDict[v] = k });

    mwi.MWICoreInitialized = true;
    mwi.game.updateNotifications("info", mwi.isZh ? "mooket加载成功" : "mooket ready");
    window.dispatchEvent(new CustomEvent("MWICoreInitialized"));
    console.info("MWICoreInitialized");
  }
  staticInit();
  new Promise(resolve => {
    let count = 0;
    const interval = setInterval(() => {
      if (mwi.game && mwi.lang && mwi?.game?.state?.character?.gameMode) {//等待必须组件加载完毕后再初始化
        clearInterval(interval);
        resolve(true);
        return;
      }
      count++;
      if (count > 30) {
        console.warn("injecting failed，部分功能可能受到影响，可以尝试刷新页面或者关闭网页重开(Steam用户请忽略)");
        clearInterval(interval);
        resolve(false);
      }
      //最多等待30秒
    }, 1000);
  }).then((ready) => {
    if (ready) {
      injectedInit();
    }
  });

  class ReconnectWebSocket {
    constructor(url, options = {}) {
      this.url = url; // WebSocket 服务器地址
      this.reconnectInterval = options.reconnectInterval || 10000; // 重连间隔（默认 5 秒）
      this.heartbeatInterval = options.heartbeatInterval || 60000; // 心跳间隔（默认 60 秒）
      this.maxReconnectAttempts = options.maxReconnectAttempts || 9999999; // 最大重连次数
      this.reconnectAttempts = 0; // 当前重连次数
      this.ws = null; // WebSocket 实例
      this.heartbeatTimer = null; // 心跳定时器
      this.isManualClose = false; // 是否手动关闭连接

      // 绑定事件处理器
      this.onOpen = options.onOpen || (() => { });
      this.onMessage = options.onMessage || (() => { });
      this.onClose = options.onClose || (() => { });
      this.onError = options.onError || (() => { });

      this.connect();
    }

    // 连接 WebSocket
    connect() {
      this.ws = new WebSocket(this.url);

      // WebSocket 打开事件
      this.ws.onopen = () => {
        console.info('WebMooket connected');
        this.reconnectAttempts = 0; // 重置重连次数
        this.startHeartbeat(); // 启动心跳
        this.onOpen();
      };

      // WebSocket 消息事件
      this.ws.onmessage = (event) => {
        this.onMessage(event.data);
      };

      // WebSocket 关闭事件
      this.ws.onclose = () => {
        console.warn('WebMooket disconnected');
        this.stopHeartbeat(); // 停止心跳
        this.onClose();

        if (!this.isManualClose) {
          this.reconnect();
        }
      };

      // WebSocket 错误事件
      this.ws.onerror = (error) => {
        console.error('WebMooket error:', error);
        this.onError(error);
      };
    }

    // 启动心跳
    startHeartbeat() {
      this.heartbeatTimer = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          //this.ws.send("ping");
        }
      }, this.heartbeatInterval);
    }

    // 停止心跳
    stopHeartbeat() {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }

    // 自动重连
    reconnect() {
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        console.info(`Reconnecting in ${this.reconnectInterval / 1000} seconds...`);
        setTimeout(() => {
          this.reconnectAttempts++;
          this.connect();
        }, this.reconnectInterval);
      } else {
        console.error('Max reconnection attempts reached');
      }
    }
    warnTimer = null; // 警告定时器


    // 发送消息
    send(data) {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(data);
      } else {
        clearTimeout(this.warnTimer);
        this.warnTimer = setTimeout(() => {
          console.warn('WebMooket is not open');
        }, 1000);
      }
    }

    // 手动关闭连接
    close() {
      this.isManualClose = true;
      this.ws.close();
    }
  }
  /*实时市场模块*/
  const HOST = "https://mooket.qi-e.top";
  const MWIAPI_URL = "https://iceking233.github.io/mwi-market-status/market/api.json";
  const OFFICIAL_HISTORY_MANIFEST_URL = "https://iceking233.github.io/mwi-market-status/market/history/official/manifest.json";
  const SQLITE_HISTORY_MANIFEST_URL = "https://iceking233.github.io/mwi-market-status/history/sqlite/manifest.json";
  const FALLBACK_MARKET_API_URL = `${HOST}/market/api.json`;
  const LEGACY_HISTORY_URL = `${HOST}/market/item/history`;
  const Q7_HISTORY_URL = "https://q7.nainai.eu.org/api/market/histories";
  const HISTORY_DB_NAME = "MWIHistoryDB";
  const HISTORY_DB_VERSION = 1;
  const OFFICIAL_HISTORY_MANIFEST_TTL = 30 * 60 * 1000;
  const SQLITE_HISTORY_MANIFEST_TTL = 6 * 3600 * 1000;
  const SQLITE_HISTORY_IMPORT_MIN_DAYS = 20;
  const officialHistoryManifestState = {
    value: null,
    fetchedAt: 0,
    inflight: null
  };
  const sqliteHistoryManifestState = {
    value: null,
    fetchedAt: 0,
    inflight: null
  };
  const historyDebugState = {
    lastChartSignature: null
  };
  function setSourceNotice(type, detail = null) {
    void type;
    void detail;
  }

  class MarketHistoryStore {
    dbPromise = null;
    init() {
      if (this.dbPromise) return this.dbPromise;
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("history_points")) {
            const store = db.createObjectStore("history_points", { keyPath: "id" });
            store.createIndex("item_variant_time", ["itemHrid", "variant", "time"], { unique: false });
            store.createIndex("time", "time", { unique: false });
            store.createIndex("source", "source", { unique: false });
          }
          if (!db.objectStoreNames.contains("meta")) {
            db.createObjectStore("meta", { keyPath: "key" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(error => {
        console.error("IndexedDB init failed", error);
        return null;
      });
      return this.dbPromise;
    }
    async setMeta(key, value) {
      const db = await this.init();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put({ key, value });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }).catch(error => console.warn("setMeta failed", key, error));
    }
    async getMeta(key) {
      const db = await this.init();
      if (!db) return null;
      return new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readonly");
        const request = tx.objectStore("meta").get(key);
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
      }).catch(error => {
        console.warn("getMeta failed", key, error);
        return null;
      });
    }
    normalizePoint(itemHrid, variant, time, point, source = "official_hourly") {
      const safeTime = Number(time) || 0;
      const safeVariant = Number(variant) || 0;
      const rawAsk = point.a ?? point.ask ?? -1;
      const rawBid = point.b ?? point.bid ?? -1;
      const rawPrice = point.p ?? point.price ?? null;
      const rawVolume = point.v ?? point.volume ?? null;
      return {
        id: `${itemHrid}:${safeVariant}:${safeTime}:${source}`,
        itemHrid,
        variant: safeVariant,
        time: safeTime,
        ask: rawAsk == null ? null : Number(rawAsk),
        bid: rawBid == null ? null : Number(rawBid),
        price: rawPrice == null ? null : Number(rawPrice),
        volume: rawVolume == null ? null : Number(rawVolume),
        source,
        importedAt: Math.floor(Date.now() / 1000)
      };
    }
    async saveOfficialSnapshot(snapshot) {
      if (!snapshot?.marketData || !snapshot?.timestamp) return 0;
      const db = await this.init();
      if (!db) return 0;

      const source = "official_hourly";
      const alreadyImportedTimestamp = await this.getMeta("officialLastSnapshotTimestamp");
      if (Number(alreadyImportedTimestamp) === Number(snapshot.timestamp)) return 0;

      const records = [];
      Object.entries(snapshot.marketData).forEach(([itemName, variants]) => {
        const itemHrid = mwi.ensureItemHrid(itemName) || itemName;
        if (!itemHrid?.startsWith("/items/")) return;
        Object.entries(variants || {}).forEach(([variant, point]) => {
          records.push(this.normalizePoint(itemHrid, variant, snapshot.timestamp, point || {}, source));
        });
      });
      if (!records.length) return 0;

      await new Promise((resolve, reject) => {
        const tx = db.transaction("history_points", "readwrite");
        const store = tx.objectStore("history_points");
        records.forEach(record => { store.put(record); });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }).catch(error => {
        console.error("saveOfficialSnapshot failed", error);
      });

      await this.setMeta("officialLastSnapshotTimestamp", Number(snapshot.timestamp));
      await this.setMeta("officialLastImportedAt", Math.floor(Date.now() / 1000));
      return records.length;
    }
    async saveHistorySeries(itemHrid, variant, rows, source = "history_import", options = {}) {
      if (!itemHrid || !Array.isArray(rows) || rows.length === 0) return 0;
      const db = await this.init();
      if (!db) return 0;
      const coverageDays = Number(options.days || 0) || 0;
      const records = rows
        .filter(row => row && Number(row.time) > 0)
        .map(row => this.normalizePoint(itemHrid, variant, row.time, row, source));
      if (!records.length) return 0;

      await new Promise((resolve, reject) => {
        const tx = db.transaction("history_points", "readwrite");
        const store = tx.objectStore("history_points");
        records.forEach(record => { store.put(record); });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }).catch(error => {
        console.error("saveHistorySeries failed", itemHrid, variant, source, error);
      });

      await this.setMeta(`history:${source}:${itemHrid}:${Number(variant) || 0}`, {
        importedAt: Math.floor(Date.now() / 1000),
        rows: records.length,
        days: coverageDays,
        earliestTime: records[0]?.time || null,
        latestTime: records[records.length - 1]?.time || null
      });
      return records.length;
    }
    async mergeHistorySeries(itemHrid, variant, rows, source = "history_import", options = {}) {
      if (!itemHrid || !Array.isArray(rows) || rows.length === 0) return 0;
      const db = await this.init();
      if (!db) return 0;
      const variantNumber = Number(variant) || 0;
      const incomingRows = rows
        .filter(row => row && Number(row.time) > 0)
        .sort((left, right) => Number(left.time) - Number(right.time));
      if (!incomingRows.length) return 0;

      const minTime = Number(incomingRows[0]?.time || 0);
      const maxTime = Number(incomingRows[incomingRows.length - 1]?.time || 0);
      if (!minTime || !maxTime) return 0;

      const existingRows = await new Promise((resolve, reject) => {
        const tx = db.transaction("history_points", "readonly");
        const index = tx.objectStore("history_points").index("item_variant_time");
        const range = IDBKeyRange.bound(
          [itemHrid, variantNumber, minTime],
          [itemHrid, variantNumber, maxTime]
        );
        const request = index.getAll(range);
        request.onsuccess = () => resolve((request.result || []).sort((a, b) => a.time - b.time));
        request.onerror = () => reject(request.error);
      }).catch(error => {
        console.error("mergeHistorySeries preload failed", itemHrid, variant, source, error);
        return [];
      });

      const byTime = new Map();
      existingRows.forEach(row => {
        const time = Number(row?.time) || 0;
        if (!time) return;
        byTime.set(time, {
          time,
          a: row.ask ?? row.a ?? null,
          b: row.bid ?? row.b ?? null,
          p: row.price ?? row.p ?? null,
          v: row.volume ?? row.v ?? null,
          source: row.source ?? null
        });
      });

      let touched = 0;
      incomingRows.forEach(row => {
        const time = Number(row.time) || 0;
        if (!time) return;
        const previous = byTime.get(time) || {
          time,
          a: null,
          b: null,
          p: null,
          v: null,
          source: null
        };
        const next = { ...previous };
        let changed = false;
        const nextAsk = row.a ?? row.ask ?? null;
        const nextBid = row.b ?? row.bid ?? null;
        const nextPrice = row.p ?? row.price ?? null;
        const nextVolume = row.v ?? row.volume ?? null;

        if ((next.v == null || Number(next.v) <= 0) && nextVolume != null && Number(nextVolume) > 0) {
          next.v = Number(nextVolume);
          changed = true;
        }
        if ((next.p == null || Number(next.p) <= 0) && nextPrice != null && Number(nextPrice) > 0) {
          next.p = Number(nextPrice);
          changed = true;
        }
        if ((next.a == null || Number(next.a) < 0) && nextAsk != null && Number(nextAsk) >= 0) {
          next.a = Number(nextAsk);
          changed = true;
        }
        if ((next.b == null || Number(next.b) < 0) && nextBid != null && Number(nextBid) >= 0) {
          next.b = Number(nextBid);
          changed = true;
        }
        if (changed || !previous.source) {
          next.source = source;
          byTime.set(time, next);
          touched += 1;
        }
      });

      if (!touched) return 0;

      const records = Array.from(byTime.values())
        .sort((left, right) => Number(left.time) - Number(right.time))
        .map(row => this.normalizePoint(itemHrid, variantNumber, row.time, row, row.source || source));

      await new Promise((resolve, reject) => {
        const tx = db.transaction("history_points", "readwrite");
        const store = tx.objectStore("history_points");
        records.forEach(record => { store.put(record); });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }).catch(error => {
        console.error("mergeHistorySeries write failed", itemHrid, variant, source, error);
      });

      await this.setMeta(`history:${source}:${itemHrid}:${variantNumber}`, {
        importedAt: Math.floor(Date.now() / 1000),
        rows: records.length,
        days: Number(options.days || 0) || 0,
        earliestTime: records[0]?.time || null,
        latestTime: records[records.length - 1]?.time || null
      });
      return touched;
    }
    async queryHistory(itemHrid, variant = 0, days = 1) {
      const db = await this.init();
      if (!db || !itemHrid) return [];
      const variantNumber = Number(variant) || 0;
      const minTime = Math.floor(Date.now() / 1000) - Number(days || 1) * 86400;
      return new Promise((resolve, reject) => {
        const tx = db.transaction("history_points", "readonly");
        const index = tx.objectStore("history_points").index("item_variant_time");
        const range = IDBKeyRange.bound([itemHrid, variantNumber, minTime], [itemHrid, variantNumber, Number.MAX_SAFE_INTEGER]);
        const request = index.getAll(range);
        request.onsuccess = () => {
          const rows = (request.result || []).sort((a, b) => a.time - b.time);
          resolve(rows);
        };
        request.onerror = () => reject(request.error);
      }).catch(error => {
        console.error("queryHistory failed", itemHrid, variant, error);
        return [];
      });
    }
    hasCoverage(rows, days = 1) {
      if (!Array.isArray(rows) || rows.length < 2) return false;
      const minTime = Math.floor(Date.now() / 1000) - Number(days || 1) * 86400;
      const earliest = Number(rows[0]?.time || 0);
      if (!earliest) return false;
      const tolerance = Math.min(6 * 3600, Math.max(3600, Number(days || 1) * 1800));
      return earliest <= minTime + tolerance;
    }
    async getHistoryStats(itemHrid, variant = 0, days = 1) {
      const db = await this.init();
      if (!db || !itemHrid) return { cachedDays: 0, cachedVolumeDays: 0, totalPoints: 0, earliestTime: null, latestTime: null };
      const variantNumber = Number(variant) || 0;
      const minTime = Math.floor(Date.now() / 1000) - Number(days || 1) * 86400;
      const countContinuousDays = (rows) => {
        const sortedDays = [...new Set(rows.map(row => {
          const d = new Date(Number(row.time || 0) * 1000);
          return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
        }))].sort((a, b) => a - b);
        if (!sortedDays.length) return 0;
        let count = 1;
        for (let i = sortedDays.length - 1; i > 0; i--) {
          if (sortedDays[i] - sortedDays[i - 1] <= 1) count += 1;
          else break;
        }
        return count;
      };
      return new Promise((resolve, reject) => {
        const tx = db.transaction("history_points", "readonly");
        const index = tx.objectStore("history_points").index("item_variant_time");
        const range = IDBKeyRange.bound([itemHrid, variantNumber, minTime], [itemHrid, variantNumber, Number.MAX_SAFE_INTEGER]);
        const request = index.getAll(range);
        request.onsuccess = () => {
          const rows = (request.result || []).sort((a, b) => a.time - b.time);
          const sourceSummary = summarizeHistorySources(rows);
          const historicalVolumeRows = rows.filter(row =>
            row.volume != null &&
            Number(row.volume) >= 0 &&
            row.source !== "official_hourly"
          );
          resolve({
            cachedDays: countContinuousDays(rows),
            cachedVolumeDays: countContinuousDays(historicalVolumeRows),
            totalPoints: rows.length,
            earliestTime: rows[0]?.time ?? null,
            latestTime: rows[rows.length - 1]?.time ?? null,
            dominantSource: sourceSummary.dominantSource,
            sourceLabels: sourceSummary.labels,
            sourceCounts: sourceSummary.counts
          });
        };
        request.onerror = () => reject(request.error);
      }).catch(error => {
        console.error("getHistoryStats failed", itemHrid, variant, error);
        return { cachedDays: 0, cachedVolumeDays: 0, totalPoints: 0, earliestTime: null, latestTime: null };
      });
    }
    toChartData(rows, stats = null, day = 1) {
      const pointsByTime = new Map();
      const sortedRows = [...(rows || [])].sort((a, b) => a.time - b.time);

      sortedRows.forEach(row => {
        const time = Number(row.time) || 0;
        if (!time) return;
        const point = pointsByTime.get(time) || {
          time,
          bid: null,
          ask: null,
          volume: null
        };
        const rowBid = row.bid ?? row.b;
        const rowAsk = row.ask ?? row.a;
        const rowVolume = row.volume ?? row.v;
        if (Number.isFinite(Number(rowBid)) && Number(rowBid) >= 0) point.bid = Number(rowBid);
        if (Number.isFinite(Number(rowAsk)) && Number(rowAsk) >= 0) point.ask = Number(rowAsk);
        if (rowVolume != null && Number.isFinite(Number(rowVolume)) && Number(rowVolume) >= 0) {
          point.volume = point.volume == null ? Number(rowVolume) : Math.max(point.volume, Number(rowVolume));
        }
        pointsByTime.set(time, point);
      });

      const bucketSeconds = Number(day) <= 3 ? 3600 : Number(day) <= 20 ? 14400 : 86400;
      const bucketMap = new Map();
      Array.from(pointsByTime.values()).forEach(point => {
        const bucketTime = Math.floor(point.time / bucketSeconds) * bucketSeconds;
        const bucket = bucketMap.get(bucketTime) || {
          time: bucketTime,
          bid: null,
          ask: null,
          volume: null
        };
        if (point.bid != null) bucket.bid = point.bid;
        if (point.ask != null) bucket.ask = point.ask;
        if (point.volume != null) bucket.volume = (bucket.volume ?? 0) + point.volume;
        bucketMap.set(bucketTime, bucket);
      });

      const bid = [];
      const ask = [];
      Array.from(bucketMap.values()).sort((a, b) => a.time - b.time).forEach(point => {
        bid.push({ time: point.time, price: point.bid, volume: point.volume });
        ask.push({ time: point.time, price: point.ask, volume: point.volume });
      });
      return { bid, ask, source: "indexeddb", stats };
    }
  }
  const marketHistoryStore = new MarketHistoryStore();

  async function fetchOfficialHistoryManifest(signal) {
    if (
      officialHistoryManifestState.value &&
      Date.now() - officialHistoryManifestState.fetchedAt < OFFICIAL_HISTORY_MANIFEST_TTL
    ) {
      return officialHistoryManifestState.value;
    }
    if (officialHistoryManifestState.inflight) {
      return officialHistoryManifestState.inflight;
    }

    officialHistoryManifestState.inflight = fetch(OFFICIAL_HISTORY_MANIFEST_URL, { signal })
      .then(response => {
        if (!response.ok) throw new Error(`Official history manifest HTTP ${response.status}`);
        return response.json();
      })
      .then(payload => {
        officialHistoryManifestState.value = payload;
        officialHistoryManifestState.fetchedAt = Date.now();
        return payload;
      })
      .finally(() => {
        officialHistoryManifestState.inflight = null;
      });

    return officialHistoryManifestState.inflight;
  }

  function toAbsoluteUrl(pathOrUrl, baseUrl = SQLITE_HISTORY_MANIFEST_URL) {
    try {
      return new URL(pathOrUrl, baseUrl).toString();
    } catch {
      return pathOrUrl;
    }
  }

  async function fetchSqliteHistoryManifest(signal) {
    if (
      sqliteHistoryManifestState.value &&
      Date.now() - sqliteHistoryManifestState.fetchedAt < SQLITE_HISTORY_MANIFEST_TTL
    ) {
      return sqliteHistoryManifestState.value;
    }
    if (sqliteHistoryManifestState.inflight) {
      return sqliteHistoryManifestState.inflight;
    }

    sqliteHistoryManifestState.inflight = fetch(SQLITE_HISTORY_MANIFEST_URL, { signal })
      .then(response => {
        if (!response.ok) throw new Error(`SQLite history manifest HTTP ${response.status}`);
        return response.json();
      })
      .then(payload => {
        sqliteHistoryManifestState.value = payload;
        sqliteHistoryManifestState.fetchedAt = Date.now();
        return payload;
      })
      .finally(() => {
        sqliteHistoryManifestState.inflight = null;
      });

    return sqliteHistoryManifestState.inflight;
  }

  function resolveSqliteHistoryManifestEntry(manifest, itemHridName) {
    if (!manifest?.items || !itemHridName) return null;

    const normalizedKey = mwi.ensureItemHrid(itemHridName) || itemHridName;
    const englishName = normalizedKey?.startsWith("/items/")
      ? mwi.lang?.en?.translation?.itemNames?.[normalizedKey]
      : null;
    const chineseName = normalizedKey?.startsWith("/items/")
      ? mwi.lang?.zh?.translation?.itemNames?.[normalizedKey]
      : null;

    const lookupKeys = [
      normalizedKey,
      itemHridName,
      englishName,
      chineseName
    ].filter(Boolean);

    for (const key of lookupKeys) {
      if (manifest.items[key]) return manifest.items[key];
    }
    return null;
  }

  function resolveOfficialHistoryManifestEntry(manifest, itemHridName, variant = 0) {
    if (!manifest?.items || !itemHridName) return null;

    const normalizedKey = mwi.ensureItemHrid(itemHridName) || itemHridName;
    const englishName = normalizedKey?.startsWith("/items/")
      ? mwi.lang?.en?.translation?.itemNames?.[normalizedKey]
      : null;
    const chineseName = normalizedKey?.startsWith("/items/")
      ? mwi.lang?.zh?.translation?.itemNames?.[normalizedKey]
      : null;

    const lookupKeys = [
      normalizedKey,
      itemHridName,
      englishName,
      chineseName
    ].filter(Boolean);

    for (const key of lookupKeys) {
      const itemEntry = manifest.items[key];
      if (!itemEntry?.variants) continue;
      const variantEntry = itemEntry.variants[String(Number(variant) || 0)];
      if (variantEntry?.path) return variantEntry;
    }
    return null;
  }

  function normalizeSqliteHistoryRows(payloadRows) {
    return (Array.isArray(payloadRows) ? payloadRows : []).map(row => ({
      time: Number(row.time) || 0,
      a: row.a ?? row.ask ?? -1,
      b: row.b ?? row.bid ?? -1,
      p: row.p ?? row.price ?? null,
      v: row.v ?? row.volume ?? null
    })).filter(row => row.time > 0);
  }

  function summarizeHistorySources(rows) {
    const counts = {};
    (rows || []).forEach(row => {
      const source = row?.source || "unknown";
      counts[source] = (counts[source] || 0) + 1;
    });
    const entries = Object.entries(counts).sort((left, right) => right[1] - left[1]);
    return {
      counts,
      labels: entries.map(([source, count]) => `${source}:${count}`),
      dominantSource: entries[0]?.[0] || null
    };
  }

  function logHistoryDebug(label, payload = {}) {
    console.info(`[mooket][history] ${label}`, payload);
  }

  function createProbeTimeoutController(timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
      controller,
      cleanup: () => clearTimeout(timer)
    };
  }

  async function probeJsonEndpoint(label, url, validate) {
    const { controller, cleanup } = createProbeTimeoutController();
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const detail = validate ? validate(payload) : null;
      return {
        label,
        ok: true,
        url,
        ms: Date.now() - startedAt,
        detail: detail || "ok"
      };
    } catch (error) {
      return {
        label,
        ok: false,
        url,
        ms: Date.now() - startedAt,
        detail: error?.name === "AbortError" ? "timeout" : (error?.message || String(error))
      };
    } finally {
      cleanup();
    }
  }

  async function runStartupHealthChecks() {
    const sampleItemHrid = "/items/apple";
    const sampleItemName = mwi.lang?.en?.translation?.itemNames?.[sampleItemHrid] || "Apple";
    const officialManifest = await probeJsonEndpoint(
      "official_history_manifest",
      OFFICIAL_HISTORY_MANIFEST_URL,
      payload => {
        const itemCount = Object.keys(payload?.items || {}).length;
        if (!itemCount) throw new Error("manifest items empty");
        return `items=${itemCount}`;
      }
    );

    let officialShard = {
      label: "official_history_shard",
      ok: false,
      url: "",
      ms: 0,
      detail: "manifest unavailable"
    };
    if (officialManifest.ok) {
      try {
        const manifest = await fetchOfficialHistoryManifest();
        const entry = resolveOfficialHistoryManifestEntry(manifest, sampleItemHrid, 0) ||
          resolveOfficialHistoryManifestEntry(manifest, sampleItemName, 0) ||
          Object.values(manifest?.items || {})[0]?.variants?.["0"];
        if (entry?.path) {
          const shardUrl = toAbsoluteUrl(entry.path, OFFICIAL_HISTORY_MANIFEST_URL);
          officialShard = await probeJsonEndpoint(
            "official_history_shard",
            shardUrl,
            payload => {
              const rows = normalizeSqliteHistoryRows(payload?.rows || payload);
              if (!rows.length) throw new Error("rows empty");
              return `rows=${rows.length}`;
            }
          );
        } else {
          officialShard.detail = "manifest entry missing";
        }
      } catch (error) {
        officialShard.detail = error?.message || String(error);
      }
    }

    const sqliteManifest = await probeJsonEndpoint(
      "sqlite_manifest",
      SQLITE_HISTORY_MANIFEST_URL,
      payload => {
        const itemCount = Object.keys(payload?.items || {}).length;
        if (!itemCount) throw new Error("manifest items empty");
        return `items=${itemCount}`;
      }
    );

    let sqliteShard = {
      label: "sqlite_shard",
      ok: false,
      url: "",
      ms: 0,
      detail: "manifest unavailable"
    };
    if (sqliteManifest.ok) {
      try {
        const manifest = await fetchSqliteHistoryManifest();
        const entry = resolveSqliteHistoryManifestEntry(manifest, sampleItemHrid) ||
          resolveSqliteHistoryManifestEntry(manifest, sampleItemName) ||
          Object.values(manifest?.items || {})[0];
        if (entry?.path) {
          const shardUrl = toAbsoluteUrl(entry.path, SQLITE_HISTORY_MANIFEST_URL);
          sqliteShard = await probeJsonEndpoint(
            "sqlite_shard",
            shardUrl,
            payload => {
              const rows = normalizeSqliteHistoryRows(payload?.rows || payload);
              if (!rows.length) throw new Error("rows empty");
              return `rows=${rows.length}`;
            }
          );
        } else {
          sqliteShard.detail = "manifest entry missing";
        }
      } catch (error) {
        sqliteShard.detail = error?.message || String(error);
      }
    }

    const githubMarketApi = await probeJsonEndpoint(
      "github_market_api",
      MWIAPI_URL,
      payload => {
        const itemCount = Object.keys(payload?.marketData || {}).length;
        if (!payload?.timestamp || !itemCount) throw new Error("marketData empty");
        return `items=${itemCount}`;
      }
    );
    const fallbackMarketApi = await probeJsonEndpoint(
      "fallback_market_api",
      FALLBACK_MARKET_API_URL,
      payload => {
        const itemCount = Object.keys(payload?.marketData || {}).length;
        if (!payload?.timestamp || !itemCount) throw new Error("marketData empty");
        return `items=${itemCount}`;
      }
    );
    const legacyHistory = await probeJsonEndpoint(
      "legacy_history",
      `${LEGACY_HISTORY_URL}?name=${encodeURIComponent(sampleItemHrid)}&level=0&time=86400`,
      payload => {
        const bidRows = payload?.bid || payload?.bids || [];
        const askRows = payload?.ask || payload?.asks || [];
        if (!Array.isArray(bidRows) || !Array.isArray(askRows)) throw new Error("payload invalid");
        return `bid=${bidRows.length},ask=${askRows.length}`;
      }
    );

    const checks = [
      githubMarketApi,
      officialManifest,
      officialShard,
      sqliteManifest,
      sqliteShard,
      fallbackMarketApi,
      legacyHistory
    ];

    const summary = checks.reduce((accumulator, check) => {
      accumulator[check.label] = {
        ok: check.ok,
        ms: check.ms,
        detail: check.detail,
        url: check.url
      };
      return accumulator;
    }, {});

    console.groupCollapsed("mooket startup health checks");
    console.table(summary);
    checks.forEach(check => {
      const prefix = check.ok ? "[OK]" : "[FAIL]";
      console[check.ok ? "info" : "warn"](`${prefix} ${check.label} ${check.ms}ms ${check.detail} ${check.url}`);
    });
    console.groupEnd();
  }

  class CoreMarket {
    marketData = {};//市场数据，带强化等级，存储格式{"/items/apple_yogurt:0":{ask,bid,time}}
    fetchTimeDict = {};//记录上次API请求时间，防止频繁请求
    ttl = 300;//缓存时间，单位秒
    trade_ws = null;
    subItems = [];
    officialSyncTimer = null;
    constructor() {
      //core data
      let marketDataStr = localStorage.getItem("MWICore_marketData") || "{}";
      this.marketData = JSON.parse(marketDataStr);
      marketHistoryStore.init();

      //mwiapi data
      let mwiapiJsonStr = localStorage.getItem("MWIAPI_JSON_NEW");
      let mwiapiObj = null;
      if (mwiapiJsonStr) {
        mwiapiObj = JSON.parse(mwiapiJsonStr);
        this.mergeMWIData(mwiapiObj);
      }
      if (!mwiapiObj || Date.now() / 1000 - mwiapiObj.timestamp > 600) {//超过10分才更新
        this.refreshOfficialMarketData();
      }
      this.officialSyncTimer = setInterval(() => { this.refreshOfficialMarketData(); }, 1000 * 600);
      //市场数据更新
      hookMessage("market_item_order_books_updated", obj => this.handleMessageMarketItemOrderBooksUpdated(obj, true));
      hookMessage("init_character_data", (msg) => {
        if (msg.character.gameMode === "standard") {//标准模式才连接ws服务器，铁牛模式不连接ws服务器)
          if (!this.trade_ws) {
            this.trade_ws = new ReconnectWebSocket(`${HOST}/market/ws`);
            this.trade_ws.onOpen = () => this.onWebsocketConnected();
            this.trade_ws.onMessage = (data) => {
              if (data === "ping") { return; }//心跳包，忽略
              let obj = JSON.parse(data);
              if (obj && obj.type === "market_item_order_books_updated") {
                this.handleMessageMarketItemOrderBooksUpdated(obj, false);//收到市场服务器数据，不上传
              } else if (obj && obj.type === "ItemPrice") {
                this.processItemPrice(obj);
              } else {
                console.warn("unknown message:", data);
              }
            }
          }
        } else {
          this.trade_ws?.close();//断开连接
          this.trade_ws = null;
        }
      });
      setInterval(() => { this.save(); }, 1000 * 600);//十分钟保存一次
    }
    async refreshOfficialMarketData(force = false) {
      let cached = JSON.parse(localStorage.getItem("MWIAPI_JSON_NEW") || "null");
      if (!force && cached?.timestamp && Date.now() / 1000 - cached.timestamp < 3300) return;
      const sources = [
        {
          label: "github_pages",
          url: MWIAPI_URL
        },
        {
          label: "legacy_market_api",
          url: FALLBACK_MARKET_API_URL,
          fallbackLabel: mwi.isZh ? "旧市场接口" : "legacy market API"
        }
      ];

      let lastError = null;
      for (const source of sources) {
        try {
          const response = await fetch(source.url, { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const mwiapiJsonStr = await response.text();
          const mwiapiObj = JSON.parse(mwiapiJsonStr);
          this.mergeMWIData(mwiapiObj);
          localStorage.setItem("MWIAPI_JSON_NEW", mwiapiJsonStr);
          setSourceNotice("market", source.label === "github_pages"
            ? null
            : {
                message: mwi.isZh
                  ? `无法访问github接口，请检查当前网络环境；当前已降级到${source.fallbackLabel}`
                  : `GitHub interface is not reachable; please check current network access. Currently using ${source.fallbackLabel}`
              });
          renderChartStatus({});
          console.info("MWIAPI_JSON updated:", source.label, new Date(mwiapiObj.timestamp * 1000).toLocaleString());
          return;
        } catch (err) {
          lastError = err;
        }
      }

      setSourceNotice("market", {
        message: cached?.timestamp
          ? (mwi.isZh
              ? "无法访问github接口，请检查当前网络环境；当前只能使用本地缓存"
              : "GitHub interface is not reachable; please check current network access. Currently using local cache only")
          : (mwi.isZh
              ? "无法访问github接口，请检查当前网络环境"
              : "GitHub interface is not reachable; please check current network access")
      });
      renderChartStatus({});
      console.warn("MWIAPI_JSON update failed, using cached/local data", lastError);
    }
    handleMessageMarketItemOrderBooksUpdated(obj, upload = false) {
      //更新本地,游戏数据不带时间戳，市场服务器数据带时间戳
      let timestamp = obj.time || parseInt(Date.now() / 1000);
      let itemHrid = obj.marketItemOrderBooks.itemHrid;
      obj.marketItemOrderBooks?.orderBooks?.forEach((item, enhancementLevel) => {
        let bid = item.bids?.length > 0 ? item.bids[0].price : -1;
        let ask = item.asks?.length > 0 ? item.asks[0].price : -1;
        this.updateItem(itemHrid + ":" + enhancementLevel, { bid: bid, ask: ask, time: timestamp });
      });
      obj.time = timestamp;//添加时间戳
      //上报数据
      if (!upload) return;//不走上报逻辑，只在收到游戏服务器数据时上报

      if (this.trade_ws) {//标准模式走ws
        this.trade_ws.send(JSON.stringify(obj));//ws上报
      } else {//铁牛上报
        fetchWithTimeout(`${HOST}/market/upload/order`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(obj)
        });
      }
    }
    onWebsocketConnected() {
      if (this.subItems?.length > 0) {//订阅物品列表
        this.trade_ws?.send(JSON.stringify({ type: "SubscribeItems", items: this.subItems }));
      }
    }
    subscribeItems(itemHridList) {//订阅物品列表，只在游戏服务器上报
      this.subItems = itemHridList;
      this.trade_ws?.send(JSON.stringify({ type: "SubscribeItems", items: itemHridList }));
    }
    /**
     * 合并MWIAPI数据，只包含0级物品
     *
     * @param obj 包含市场数据的对象
     */
    mergeMWIData(obj) {
      Object.entries(obj.marketData).forEach(([itemName, priceDict]) => {
        let itemHrid = mwi.ensureItemHrid(itemName);
        if (itemHrid) {
          Object.entries(priceDict).forEach(([enhancementLevel, price]) => {
            this.updateItem(itemHrid + ":" + enhancementLevel, {
              bid: price.b,
              ask: price.a,
              avg: price.p ?? 0,
              volume: price.v ?? 0,
              time: obj.timestamp
            }, false);
          });
        }
      });
      marketHistoryStore.saveOfficialSnapshot(obj);
      this.save();
    }
    mergeCoreDataBeforeSave() {
      let obj = JSON.parse(localStorage.getItem("MWICore_marketData") || "{}");
      Object.entries(obj).forEach(([itemHridLevel, priceObj]) => {
        this.updateItem(itemHridLevel, priceObj, false);//本地更新
      });
      //不保存，只合并
    }
    save() {//保存到localStorage
      if (mwi.character?.gameMode !== "standard") return;//非标准模式不保存
      this.mergeCoreDataBeforeSave();//从其他角色合并保存的数据
      localStorage.setItem("MWICore_marketData", JSON.stringify(this.marketData));
    }

    /**
     * 部分特殊物品的价格
     * 例如金币固定1，牛铃固定为牛铃袋/10的价格
     * @param {string} itemHrid - 物品hrid
     * @returns {Price|null} - 返回对应商品的价格对象，如果没有则null
     */
    getSpecialPrice(itemHrid) {
      switch (itemHrid) {
        case "/items/coin":
          return { bid: 1, ask: 1, time: Date.now() / 1000 };
        case "/items/cowbell": {
          let cowbells = this.getItemPrice("/items/bag_of_10_cowbells");
          return cowbells && { bid: cowbells.bid / 10, ask: cowbells.ask / 10, time: cowbells.time };
        }
        case "/items/bag_of_10_cowbells": return null;//走普通get,这里返回空
        case "/items/task_crystal": {//固定点金收益5000，这里计算可能有bug
          return { bid: 5000, ask: 5000, time: Date.now() / 1000 }
        }
        default: {
          let itemDetail = mwi.getItemDetail(itemHrid);
          if (itemDetail?.categoryHrid === "/item_categories/loot") {//宝箱陨石
            let totalAsk = 0;
            let totalBid = 0;
            let minTime = Date.now() / 1000;
            this.getOpenableItems(itemHrid)?.forEach(openItem => {
              let price = this.getItemPrice(openItem.itemHrid);
              if (price) minTime = Math.min(minTime, price.time);
              totalAsk += (price?.ask || 0) * openItem.count;//可以算平均价格
              totalBid += (price?.bid || 0) * openItem.count;
            });
            return { bid: totalBid, ask: totalAsk, time: minTime };
          }

          if (mwi.character?.gameMode !== "standard") {//其他物品都按点金分解价值
            return { ask: itemDetail.sellPrice * 5 * 0.7, bid: itemDetail.sellPrice * 5 * 0.7, time: Date.now() / 1000 };//铁牛模式显示物品价值使用点金价格*几率
          }

          return null;
        }
      }
    }
    getOpenableItems(itemHrid) {
      let items = [];
      for (let openItem of mwi.initClientData.openableLootDropMap[itemHrid]) {
        if (openItem.itemHrid === "/items/purples_gift") continue;//防止循环
        items.push({
          itemHrid: openItem.itemHrid,
          count: (openItem.minCount + openItem.maxCount) / 2 * openItem.dropRate
        });
      }
      return items;
    }
    /**
     * 获取商品的价格
     *
     * @param {string} itemHridOrName 商品HRID或名称
     * @param {number} [enhancementLevel=0] 装备强化等级，普通商品默认为0
     * @param {boolean} [peek=false] 是否只查看本地数据，不请求服务器数据
     * @returns {number|null} 返回商品的价格，如果商品不存在或无法获取价格则返回null
     */
    getItemPrice(itemHridOrName, enhancementLevel = 0, peek = false) {
      if (itemHridOrName?.includes(":")) {//兼容单名称，例如"itemHrid:enhancementLevel"
        let arr = itemHridOrName.split(":");
        itemHridOrName = arr[0];
        enhancementLevel = parseInt(arr[1]);
      }
      let itemHrid = mwi.ensureItemHrid(itemHridOrName);
      if (!itemHrid) return null;
      let specialPrice = this.getSpecialPrice(itemHrid);
      if (specialPrice) return specialPrice;
      let itemHridLevel = itemHrid + ":" + enhancementLevel;

      let priceObj = this.marketData[itemHridLevel];
      if (peek) return priceObj;

      if (Date.now() / 1000 - this.fetchTimeDict[itemHridLevel] < this.ttl) return priceObj;//1分钟内直接返回本地数据，防止频繁请求服务器
      this.fetchTimeDict[itemHridLevel] = Date.now() / 1000;
      this.trade_ws?.send(JSON.stringify({ type: "GetItemPrice", name: itemHrid, level: enhancementLevel }));
      return priceObj;
    }
    processItemPrice(resObj) {
      let itemHridLevel = resObj.name + ":" + resObj.level;
      let oldItem = this.marketData[itemHridLevel] || {};

      let priceObj = {
        bid: resObj.bid,
        ask: resObj.ask,
        time: resObj.time,
        avg: oldItem.avg ?? 0,
        volume: oldItem.volume ?? 0
      };

      if (resObj.ttl) this.ttl = resObj.ttl;
      this.updateItem(itemHridLevel, priceObj);
    }

    updateItem(itemHridLevel, priceObj, isFetch = true) {
      let localItem = this.marketData[itemHridLevel];
      if (isFetch) this.fetchTimeDict[itemHridLevel] = Date.now() / 1000;

      if (!localItem || localItem.time < priceObj.time || localItem.time > Date.now() / 1000) {
        let risePercent = 0;
        if (localItem) {
          let oriPrice = (localItem.ask + localItem.bid);
          let newPrice = (priceObj.ask + priceObj.bid);
          if (oriPrice != 0) risePercent = newPrice / oriPrice - 1;
        }

        this.marketData[itemHridLevel] = {
          rise: risePercent,
          ask: priceObj.ask,
          bid: priceObj.bid,
          avg: priceObj.avg ?? localItem?.avg ?? 0,
          volume: priceObj.volume ?? localItem?.volume ?? 0,
          time: priceObj.time
        };

        dispatchEvent(new CustomEvent("MWICoreItemPriceUpdated", {
          detail: { priceObj: this.marketData[itemHridLevel], itemHridLevel: itemHridLevel }
        }));
      }
    }
    resetRise() {
      Object.entries(this.marketData).forEach(([k, v]) => {
        v.rise = 0;
      });
    }
  }
  mwi.coreMarket = new CoreMarket();
  /*历史数据模块*/
  function mooket() {

    mwi.hookMessage("market_listings_updated", obj => {
      obj.endMarketListings.forEach(order => {
        if (order.filledQuantity == 0) return;//没有成交的订单不记录
        let key = order.itemHrid + ":" + order.enhancementLevel;

        let tradeItem = trade_history[key] || {}
        if (order.isSell) {
          tradeItem.sell = order.price;
        } else {
          tradeItem.buy = order.price;
        }
        trade_history[key] = tradeItem;
      });
      if (mwi.character?.gameMode === "standard") {//只记录标准模式的数据，因为铁牛不能交易
        localStorage.setItem("mooket_trade_history", JSON.stringify(trade_history));//保存挂单数据
      }
    });



    let curDay = 1;
    let curHridName = null;
    let curLevel = 0;
    let curShowItemName = null;

    let delayItemHridName = null;
    let delayItemLevel = 0;

    let chartWidth = 900;
    let chartHeight = 420;

    let configStr = localStorage.getItem("mooket_config");

    let config = configStr ? JSON.parse(configStr) : {
      dayIndex: 0,
      visible: true,
      filter: {
        bid: true,
        ask: true,
        volume: true
      },
      indicators: {
        ma: true,
        boll: true,
        spread: true
      },
      favo: {}
    };

    config.favo = config.favo || {};
    config.indicators = Object.assign({
      ma: true,
      boll: true,
      spread: true
    }, config.indicators || {});
    if (config.indicatorsPresetVersion !== 2) {
      config.indicators.ma = true;
      config.indicators.boll = true;
      config.indicators.spread = true;
      config.indicatorsPresetVersion = 2;
    }

    let trade_history = JSON.parse(localStorage.getItem("mooket_trade_history") || "{}");
    function trade_history_migrate() {
      if (config?.version > 1) return;
      //把trade_history的key从itemHrid_enhancementLevel改为itemHrid:enhancementLevel
      let new_trade_history = {};
      for (let oldKey in trade_history) {
        if (/_(\d+)/.test(oldKey)) {
          let newKey = oldKey.replace(/_(\d+)/, ":$1");
          new_trade_history[newKey] = trade_history[oldKey];
        } else {

        }
      }
      localStorage.setItem("mooket_trade_history", JSON.stringify(new_trade_history));//保存挂单数据
      trade_history = new_trade_history;
      config.version = 1.1;
    }
    trade_history_migrate();

    window.addEventListener('resize', function () {
      checkSize();
    });
    function checkSize() {
      if (window.innerWidth < window.innerHeight) {
        config.w = chartWidth = window.innerWidth * 0.92;
        config.h = chartHeight = Math.max(320, chartWidth * 0.72);
      } else {
        chartWidth = 640;
        chartHeight = 420;
      }
    }
    checkSize();

    function getExpandedBounds() {
      return {
        maxWidth: Math.max(860, window.innerWidth),
        maxHeight: Math.max(560, window.innerHeight)
      };
    }

    function keepToggleButtonVisible() {
      const rect = container.getBoundingClientRect();
      const buttonRect = btn_close.getBoundingClientRect();
      let nextLeft = rect.left;
      let nextTop = rect.top;

      if (buttonRect.left < 0) nextLeft += -buttonRect.left;
      if (buttonRect.right > window.innerWidth) nextLeft -= (buttonRect.right - window.innerWidth);
      if (buttonRect.top < 0) nextTop += -buttonRect.top;
      if (buttonRect.bottom > window.innerHeight) nextTop -= (buttonRect.bottom - window.innerHeight);

      container.style.left = `${Math.round(nextLeft)}px`;
      container.style.top = `${Math.round(nextTop)}px`;
    }

    function clampExpandedContainer() {
      const { maxWidth, maxHeight } = getExpandedBounds();
      if (uiContainer.style.display === 'none') return;

      const nextWidth = Math.min(container.offsetWidth || config.w || chartWidth, maxWidth);
      const nextHeight = Math.min(container.offsetHeight || config.h || chartHeight, maxHeight);
      container.style.width = `${nextWidth}px`;
      container.style.height = `${nextHeight}px`;
      container.style.maxWidth = `${maxWidth}px`;
      container.style.maxHeight = `${maxHeight}px`;
      keepToggleButtonVisible();
    }

    // 创建容器元素并设置样式和位置
    const container = document.createElement('div');
    container.style.border = "1px solid #2a2e39";
    container.style.background = "#12161c";
    container.style.boxShadow = "0 8px 28px rgba(0,0,0,0.45)";
    container.style.borderRadius = "12px";
    container.style.position = "fixed";
    container.style.zIndex = 10000;
    const initialBounds = getExpandedBounds();
    const initialWidth = Math.max(860, Math.min(config.w || chartWidth, initialBounds.maxWidth));
    const initialHeight = Math.max(560, Math.min(config.h || chartHeight, initialBounds.maxHeight));
    container.style.top = `${Math.max(0, Number(config.y) || 0)}px`;
    container.style.left = `${Math.max(0, Number(config.x) || 0)}px`;
    container.style.width = `${initialWidth}px`;
    container.style.height = `${initialHeight}px`;
    container.style.resize = config.visible === false ? "none" : "both";
    container.style.overflow = "hidden";
    container.style.minHeight = "560px";
    container.style.minWidth = "860px";
    container.style.maxWidth = `${initialBounds.maxWidth}px`;
    container.style.userSelect = "none";
    container.style.boxSizing = "border-box";

    document.body.appendChild(container);

    // 顶部栏
    const headerBar = document.createElement('div');
    headerBar.style.display = 'flex';
    headerBar.style.alignItems = 'center';
    headerBar.style.justifyContent = 'flex-start';
    headerBar.style.gap = '8px';
    headerBar.style.height = '46px';
    headerBar.style.padding = '8px 10px';
    headerBar.style.boxSizing = 'border-box';
    headerBar.style.borderBottom = '1px solid rgba(255,255,255,0.06)';
    headerBar.style.background = 'rgba(18,22,28,0.96)';
    headerBar.style.cursor = 'move';

    container.appendChild(headerBar);

    function applyExpandedShell() {
      const { maxWidth, maxHeight } = getExpandedBounds();
      container.style.border = "1px solid #2a2e39";
      container.style.background = "#12161c";
      container.style.boxShadow = "0 8px 28px rgba(0,0,0,0.45)";
      container.style.borderRadius = "12px";
      container.style.padding = "0";
      container.style.maxWidth = `${maxWidth}px`;
      container.style.maxHeight = `${maxHeight}px`;
      headerBar.style.height = '46px';
      headerBar.style.padding = '8px 10px';
      headerBar.style.borderBottom = '1px solid rgba(255,255,255,0.06)';
      headerBar.style.background = 'rgba(18,22,28,0.96)';
    }

    function applyCollapsedShell() {
      container.style.border = "none";
      container.style.background = "transparent";
      container.style.boxShadow = "none";
      container.style.borderRadius = "0";
      container.style.padding = "0";
      container.style.maxWidth = "none";
      container.style.maxHeight = "none";
      headerBar.style.height = 'auto';
      headerBar.style.padding = '0';
      headerBar.style.borderBottom = 'none';
      headerBar.style.background = 'transparent';
    }

    // 主布局
    const uiContainer = document.createElement('div');
    uiContainer.style.display = 'flex';
    uiContainer.style.flexDirection = 'row';
    uiContainer.style.alignItems = 'stretch';
    uiContainer.style.gap = '10px';
    uiContainer.style.width = '100%';
    uiContainer.style.height = 'calc(100% - 46px)';
    uiContainer.style.boxSizing = 'border-box';
    uiContainer.style.overflow = 'hidden';
    uiContainer.style.padding = '8px';
    container.appendChild(uiContainer);

    // 左侧主区域
    const leftContainer = document.createElement('div');
    leftContainer.style.display = 'flex';
    leftContainer.style.flexDirection = 'column';
    leftContainer.style.flex = '1 1 auto';
    leftContainer.style.minWidth = '0';
    leftContainer.style.height = '100%';
    leftContainer.style.boxSizing = 'border-box';
    leftContainer.style.gap = '8px';
    leftContainer.style.position = 'relative';
    leftContainer.style.padding = '0';
    leftContainer.style.background = 'transparent';
    uiContainer.appendChild(leftContainer);

    const days = [1, 3, 7, 20, 60, 180, 365];
    if (typeof config.dayIndex !== "number" || config.dayIndex < 0 || config.dayIndex >= days.length) {
    config.dayIndex = 0;
    }
    curDay = days[config.dayIndex];

    // 显示/隐藏按钮
    let btn_close = document.createElement('input');
    btn_close.type = 'button';
    btn_close.style.margin = '0';
    btn_close.style.cursor = 'pointer';
    btn_close.style.height = '30px';
    btn_close.style.padding = '0 12px';
    btn_close.style.background = '#1b2028';
    btn_close.style.color = '#e7ebf0';
    btn_close.style.border = '1px solid #2f3541';
    btn_close.style.borderRadius = '8px';
    btn_close.style.outline = 'none';

    btn_close.value = config.visible
      ? '📈' + (mwi.isZh ? '隐藏图表' : 'Hide')
      : '📈' + (mwi.isZh ? '显示图表' : 'Show');

    headerBar.appendChild(btn_close);

    // 时间下拉
    let select = document.createElement('select');
    select.style.cursor = 'pointer';
    select.style.verticalAlign = 'middle';
    select.style.height = '30px';
    select.style.minWidth = '88px';
    select.style.padding = '0 10px';
    select.style.marginLeft = '0';
    select.style.background = '#1b2028';
    select.style.color = '#e7ebf0';
    select.style.border = '1px solid #2f3541';
    select.style.borderRadius = '8px';
    select.style.outline = 'none';

    select.onchange = function () {
    config.dayIndex = this.selectedIndex;
    if (curHridName) requestItemPrice(curHridName, this.value, curLevel);
    save_config();
    };

    for (let i = 0; i < days.length; i++) {
    let option = document.createElement('option');
    option.value = days[i];
    if (i === config.dayIndex) option.selected = true;
    select.appendChild(option);
    }

    function updateMoodays() {
    const labels = mwi.isZh ? ["1天", "3天", "7天", "20天", "60天", "180天", "365天"] : ["1D", "3D", "7D", "20D", "60D", "180D", "365D"];
    for (let i = 0; i < select.options.length; i++) {
    select.options[i].text = labels[i];
    }
    }
    updateMoodays();
    headerBar.appendChild(select);

    const indicatorBar = document.createElement('div');
    indicatorBar.id = 'mooket_indicator_bar';
    indicatorBar.style.display = 'flex';
    indicatorBar.style.alignItems = 'center';
    indicatorBar.style.justifyContent = 'flex-start';
    indicatorBar.style.flexWrap = 'wrap';
    indicatorBar.style.gap = '6px';
    indicatorBar.style.minHeight = '30px';
    indicatorBar.style.padding = '0';
    indicatorBar.style.marginLeft = '0';
    headerBar.appendChild(indicatorBar);

    const headerSpacer = document.createElement('div');
    headerSpacer.style.flex = '1 1 auto';
    headerSpacer.style.minWidth = '12px';
    headerBar.appendChild(headerSpacer);

    const indicatorButtons = {};

    function getIndicatorButtonLabel(key) {
      switch (key) {
        case 'ma':
          return mwi.isZh ? 'MA(mid)' : 'MA(mid)';
        case 'boll':
          return mwi.isZh ? '布林线' : 'Boll';
        case 'spread':
          return mwi.isZh ? '价差线' : 'Spread';
        default:
          return key;
      }
    }

    function applyIndicatorButtonState(button, active) {
      button.style.background = active ? 'rgba(66, 133, 244, 0.18)' : '#1b2028';
      button.style.borderColor = active ? 'rgba(96, 165, 250, 0.72)' : '#2f3541';
      button.style.color = active ? '#dbeafe' : '#aeb7c3';
      button.style.boxShadow = active ? 'inset 0 0 0 1px rgba(96, 165, 250, 0.12)' : 'none';
    }

    function rerenderCurrentChart() {
      if (!lastChartPayload?.data) return;
      updateChart(cloneChartDataPayload(lastChartPayload.data), lastChartPayload.day);
    }

    function updateIndicatorButtons() {
      Object.entries(indicatorButtons).forEach(([key, button]) => {
        button.textContent = getIndicatorButtonLabel(key);
        applyIndicatorButtonState(button, !!config.indicators?.[key]);
      });
    }

    function createIndicatorButton(key) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.indicatorKey = key;
      button.style.height = '30px';
      button.style.padding = '0 12px';
      button.style.borderRadius = '8px';
      button.style.border = '1px solid #2f3541';
      button.style.background = '#1b2028';
      button.style.color = '#aeb7c3';
      button.style.cursor = 'pointer';
      button.style.fontSize = '12px';
      button.style.fontWeight = '600';
      button.style.letterSpacing = '0.01em';
      button.style.minWidth = '76px';
      button.style.transition = 'background 120ms ease, border-color 120ms ease, color 120ms ease';
      button.onclick = () => {
        config.indicators[key] = !config.indicators[key];
        updateIndicatorButtons();
        rerenderCurrentChart();
        save_config();
      };
      indicatorButtons[key] = button;
      indicatorBar.appendChild(button);
    }

    createIndicatorButton('ma');
    createIndicatorButton('boll');
    createIndicatorButton('spread');
    updateIndicatorButtons();

    function isResizeHandleHit(event) {
      if (uiContainer.style.display === 'none') return false;
      const rect = container.getBoundingClientRect();
      const resizeEdge = 14;
      return (
        rect.right - event.clientX <= resizeEdge &&
        rect.bottom - event.clientY <= resizeEdge
      );
    }

    function canStartPanelDrag(event) {
      if (event.button !== 0) return false;
      if (isResizeHandleHit(event)) return false;
      const interactiveSelector = [
        'input',
        'button',
        'select',
        'option',
        'canvas',
        'a',
        '[role="button"]',
        '[class*="Item_itemContainer__"]',
        '#mooket_favo_panel',
        '#mooket_orderbook_table'
      ].join(', ');
      if (event.target.closest(interactiveSelector)) {
        return event.target === btn_close && uiContainer.style.display === 'none';
      }
      return event.target === container || event.target === headerBar || headerBar.contains(event.target);
    }

    function bindPanelDrag() {
      let dragState = null;
      let suppressToggleClick = false;

      const movePanel = (clientX, clientY) => {
        if (!dragState) return;
        const deltaX = clientX - dragState.startX;
        const deltaY = clientY - dragState.startY;
        if (!dragState.active && Math.hypot(deltaX, deltaY) < 4) return;

        dragState.active = true;
        suppressToggleClick = true;
        document.body.style.userSelect = 'none';
        container.style.left = `${dragState.startLeft + deltaX}px`;
        container.style.top = `${dragState.startTop + deltaY}px`;
        keepToggleButtonVisible();
      };

      container.addEventListener('mousedown', (event) => {
        if (!canStartPanelDrag(event)) return;
        dragState = {
          startX: event.clientX,
          startY: event.clientY,
          startLeft: parseFloat(container.style.left) || 0,
          startTop: parseFloat(container.style.top) || 0,
          active: false
        };
      });

      document.addEventListener('mousemove', (event) => {
        movePanel(event.clientX, event.clientY);
      });

      document.addEventListener('mouseup', () => {
        if (!dragState) return;
        const wasDragging = dragState.active;
        dragState = null;
        document.body.style.userSelect = '';
        if (wasDragging) save_config();
        setTimeout(() => { suppressToggleClick = false; }, 0);
      });

      btn_close.addEventListener('click', (event) => {
        if (!suppressToggleClick) return;
        event.preventDefault();
        event.stopPropagation();
      }, true);
    }
    bindPanelDrag();

    // 图表区域
    const chartWrap = document.createElement('div');
    chartWrap.style.display = 'block';
    chartWrap.style.position = 'relative';
    chartWrap.style.flex = '1 1 auto';
    chartWrap.style.minHeight = '260px';
    chartWrap.style.width = '100%';
    chartWrap.style.boxSizing = 'border-box';
    chartWrap.style.padding = '8px 10px 16px 10px';
    chartWrap.style.background = 'rgba(10,16,24,0.88)';
    chartWrap.style.border = '1px solid rgba(255,255,255,0.06)';
    chartWrap.style.borderRadius = '12px';
    chartWrap.style.overflow = 'hidden';
    leftContainer.appendChild(chartWrap);

    const metricBar = document.createElement('div');
    metricBar.id = 'mooket_metric_bar';
    metricBar.style.display = 'flex';
    metricBar.style.alignItems = 'center';
    metricBar.style.flexWrap = 'wrap';
    metricBar.style.gap = '14px';
    metricBar.style.padding = '0 0 6px 0';
    metricBar.style.color = '#c8d1dc';
    metricBar.style.fontSize = '12px';
    metricBar.style.justifyContent = 'flex-start';
    chartWrap.appendChild(metricBar);

    const ctx = document.createElement('canvas');
    ctx.style.display = 'block';
    ctx.style.width = '100%';
    ctx.style.height = '100%';
    ctx.id = "mooket_chart";
    chartWrap.appendChild(ctx);

    const externalTooltip = document.createElement('div');
    externalTooltip.id = 'mooket_chart_tooltip';
    externalTooltip.style.position = 'fixed';
    externalTooltip.style.left = '0';
    externalTooltip.style.top = '0';
    externalTooltip.style.display = 'none';
    externalTooltip.style.pointerEvents = 'none';
    externalTooltip.style.zIndex = '2147483647';
    externalTooltip.style.maxWidth = '280px';
    externalTooltip.style.padding = '10px 12px';
    externalTooltip.style.borderRadius = '12px';
    externalTooltip.style.border = '1px solid #343b48';
    externalTooltip.style.background = 'rgba(27,32,40,0.97)';
    externalTooltip.style.boxShadow = '0 12px 30px rgba(0,0,0,0.35)';
    externalTooltip.style.color = '#d7dde6';
    externalTooltip.style.fontSize = '12px';
    externalTooltip.style.lineHeight = '1.45';
    externalTooltip.style.whiteSpace = 'nowrap';
    externalTooltip.style.backdropFilter = 'blur(6px)';
    document.body.appendChild(externalTooltip);

    // 右侧自选
    let favoContainer = document.createElement('div');
    favoContainer.id = "mooket_favo_panel";
    favoContainer.style.position = 'relative';
    favoContainer.style.flex = '0 0 220px';
    favoContainer.style.width = '220px';
    favoContainer.style.minWidth = '220px';
    favoContainer.style.height = '100%';
    favoContainer.style.borderLeft = '1px solid rgba(255,255,255,0.06)';
    favoContainer.style.background = 'rgba(10,16,24,0.88)';
    favoContainer.style.overflowY = 'auto';
    favoContainer.style.overflowX = 'hidden';
    favoContainer.style.padding = '6px';
    favoContainer.style.boxSizing = 'border-box';
    favoContainer.style.display = 'grid';
    favoContainer.style.gridAutoFlow = 'column';
    favoContainer.style.gridTemplateRows = 'repeat(1, 56px)';
    favoContainer.style.gridTemplateColumns = 'repeat(1, minmax(200px, 1fr))';
    favoContainer.style.gap = '6px';
    favoContainer.style.alignContent = 'start';
    favoContainer.title = "Favorite Items";
    favoContainer.style.scrollbarWidth = 'thin';

    uiContainer.appendChild(favoContainer);

    function updateFavoLayout() {
      if (!favoContainer) return;

      const expanded = uiContainer.style.display !== 'none';
      if (!expanded) {
        favoContainer.style.display = 'none';
        return;
      }

      const itemCount = favoContainer.children.length;

      favoContainer.style.display = 'grid';
      favoContainer.style.overflowY = 'auto';
      favoContainer.style.overflowX = 'hidden';

      const rowHeight = 28;
      const gap = 6;
      const singleColWidth = 220;
      const doubleColWidth = 430;

      const containerHeight = Math.max(120, favoContainer.clientHeight - 4);
      const rowsPerColumnMax = Math.max(
        1,
        Math.floor((containerHeight + gap) / (rowHeight + gap))
      );

      const columns = itemCount <= rowsPerColumnMax ? 1 : 2;

      // 关键：实际每列显示多少行，不能直接用最大可容纳行数
      const rowsPerColumnActual = columns === 1
        ? Math.max(1, itemCount)
        : Math.max(1, Math.ceil(itemCount / 2));

      favoContainer.style.gridAutoFlow = 'column';
      favoContainer.style.gridTemplateRows = `repeat(${rowsPerColumnActual}, ${rowHeight}px)`;
      favoContainer.style.gridTemplateColumns = `repeat(${columns}, minmax(200px, 1fr))`;
      favoContainer.style.gridAutoRows = '';
      favoContainer.style.gap = `${gap}px`;
      favoContainer.style.alignContent = 'start';

      const panelWidth = columns === 1 ? singleColWidth : doubleColWidth;
      favoContainer.style.flex = `0 0 ${panelWidth}px`;
      favoContainer.style.width = `${panelWidth}px`;
      favoContainer.style.minWidth = `${panelWidth}px`;
    }

    function sendFavo() {
      if (mwi.character?.gameMode !== "standard") return;
      let items = new Set();
      Object.entries(config.favo || {}).forEach(([itemHridLevel, data]) => {
        items.add(itemHridLevel.split(":")[0]);
      });
      //if(items.size > 10)mwi.game?.updateNotifications("info",mwi.isZh?"当前的自选物品种类已超过10个，服务器仅会自动推送前10个物品的最新价格":"");
      mwi.coreMarket.subscribeItems(Array.from(items));
      updateFavo();
    }
    function addFavo(itemHridLevel) {
      if (mwi.character?.gameMode !== "standard") return;
      let priceObj = mwi.coreMarket.getItemPrice(itemHridLevel);
      config.favo[itemHridLevel] = { ask: priceObj.ask, bid: priceObj.bid, time: priceObj.time };
      save_config();
      sendFavo();
    }
    function removeFavo(itemHridLevel) {
      if (mwi.character?.gameMode !== "standard") return;
      delete config.favo[itemHridLevel];
      save_config();
      sendFavo();
    }
    function getItemHridLevelFromElement(itemRoot) {
      if (!itemRoot) return null;
      const useEl = itemRoot.querySelector('svg.Icon_icon__2LtL_ use, [class*="Icon_icon__"] use');
      const href = useEl?.getAttribute('href') || useEl?.getAttribute('xlink:href') || useEl?.href?.baseVal;
      const iconName = href?.split('#')[1];
      if (!iconName) return null;

      const levelText = itemRoot.querySelector('.Item_enhancementLevel__19g-e, [class*="Item_enhancementLevel__"]')?.textContent || '';
      const enhancementLevel = parseInt(levelText.replace('+', '').trim() || '0', 10) || 0;
      return `/items/${iconName}:${enhancementLevel}`;
    }
    function bindGlobalItemContextMenu() {
      document.addEventListener('contextmenu', (event) => {
        if (mwi.character?.gameMode !== "standard") return;
        if (favoContainer.contains(event.target)) return;
        if (event.target.closest('#mooket_addFavo')) return;

        const itemRoot = event.target.closest(
          '.MarketplacePanel_marketItems__D4k7e [class*="Item_itemContainer__"], ' +
          'td[class*="MarketplacePanel_item__"] [class*="Item_itemContainer__"], ' +
          '.InventoryPanel_inventoryPanel__2wTeg [class*="Item_itemContainer__"], ' +
          '[class*="InventoryPanel_inventoryPanel__"] [class*="Item_itemContainer__"]'
        );
        if (!itemRoot) return;

        const itemHridLevel = getItemHridLevelFromElement(itemRoot);
        if (!itemHridLevel) return;

        event.preventDefault();
        addFavo(itemHridLevel);
      });
    }
    function updateFavo() {
      if (mwi.character?.gameMode !== "standard") {
        favoContainer.style.display = 'none';
        return;
      }
      //在favoContainer中添加config.favo dict中 key对应的元素，或者删除不存在的
      let items = Object.keys(config.favo);
      for (let i = 0; i < favoContainer.children.length; i++) {
        if (!items.includes(favoContainer.children[i].id)) {
          favoContainer.removeChild(favoContainer.children[i]);
        }
      }
      for (let itemHridLevel of items) {
        let favoItemDiv = document.getElementById(itemHridLevel);

        let oldPrice = config.favo[itemHridLevel];
        let newPrice = mwi.coreMarket.getItemPrice(itemHridLevel);

        oldPrice.ask = oldPrice?.ask > 0 ? oldPrice.ask : newPrice?.ask;//如果旧价格没有ask，就用新价格的ask代替
        oldPrice.bid = oldPrice?.bid > 0 ? oldPrice.bid : newPrice?.bid;//如果旧价格没有bid，就用新价格的bid代替


        let priceDelta = {
          ask: newPrice?.ask > 0 ? showNumber(newPrice.ask) : "-",
          bid: newPrice?.bid > 0 ? showNumber(newPrice.bid) : "-",
          askRise: (oldPrice?.ask > 0 && newPrice?.ask > 0) ? (100 * (newPrice.ask - oldPrice.ask) / oldPrice.ask).toFixed(1) : 0,
          bidRise: (oldPrice?.bid > 0 && newPrice?.bid > 0) ? (100 * (newPrice.bid - oldPrice.bid) / oldPrice.bid).toFixed(1) : 0,
        };
        let [itemHrid, level] = itemHridLevel.split(":");
        let iconName = itemHrid.split("/")[2];
        let itemName = mwi.isZh ? mwi.lang.zh.translation.itemNames[itemHrid] : mwi.lang.en.translation.itemNames[itemHrid];


        if (!favoItemDiv) {
          favoItemDiv = document.createElement('div');
          //div.style.border = '1px solid #90a6eb';
          favoItemDiv.style.color = 'white';
          favoItemDiv.style.whiteSpace = 'nowrap';
          favoItemDiv.style.cursor = 'pointer';
          favoItemDiv.style.width = '100%';
          favoItemDiv.style.minWidth = '0';
          favoItemDiv.onclick = function () {
            let [itemHrid, level] = itemHridLevel.split(":")
            const safeLevel = parseInt(level, 10) || 0;
            mwi.game?.handleGoToMarketplace?.(itemHrid, safeLevel);//只使用官方接口跳转
            if (uiContainer.style.display === 'none') {
              delayItemHridName = itemHrid;
              delayItemLevel = safeLevel;
            } else {
              setTimeout(() => {
                try {
                  requestItemPrice(itemHrid, curDay, safeLevel);
                } catch (error) {
                  console.warn("收藏跳转后的图表刷新失败", itemHrid, safeLevel, error);
                }
              }, 0);
            }
            //toggleShow(true);
          };
          favoItemDiv.oncontextmenu = (event) => { event.preventDefault(); removeFavo(itemHridLevel); };
          favoItemDiv.id = itemHridLevel;
          favoContainer.appendChild(favoItemDiv);
        }
        //鼠标如果在div范围内就显示fullinfo
        let favoMode = uiContainer.style.display === 'none' ? config.favoModeOff : config.favoModeOn;
        let title = `${itemName}${level > 0 ? `(+${level})` : ""} ${priceDelta.ask} ${priceDelta.askRise > 0 ? "+" : ""}${priceDelta.askRise}% ${new Date((newPrice?.time || 0) * 1000).toLocaleString()}`;
        let riseColor = Number(priceDelta.askRise) > 0 ? '#ff4d4f' : Number(priceDelta.askRise) < 0 ? '#00c087' : '#9aa4b2';
        let riseText = Number(priceDelta.askRise) > 0 ? `+${priceDelta.askRise}%` : `${priceDelta.askRise}%`;

        favoItemDiv.innerHTML = `
        <div title="${title}" style="
          width:100%;
          height:28px;
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:6px;
          padding:5px 7px;
          box-sizing:border-box;
          border:1px solid #2a2e39;
          border-radius:8px;
          background:#151b22;
          color:#e7ebf0;
          font-size:12px;
          line-height:1.1;
          overflow:hidden;
        ">
          <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1;">
            <svg width="16" height="16" style="flex:0 0 auto;display:block;">
              <use href="/static/media/items_sprite.d4d08849.svg#${iconName}"></use>
            </svg>

            <div style="display:flex;flex-direction:column;justify-content:center;gap:2px;min-width:0;flex:1;">
              <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                <span style="color:#ff6b6b;white-space:nowrap;">${mwi.isZh ? '卖' : 'Ask'} ${priceDelta.ask}</span>
                <span style="color:#20c997;white-space:nowrap;">${mwi.isZh ? '买' : 'Bid'} ${priceDelta.bid}</span>
              </div>
            </div>
          </div>

          <span style="color:${riseColor};white-space:nowrap;font-weight:600;font-size:12px;flex:0 0 auto;">
            ${riseText}
          </span>
        </div>
      `;
      }
      updateFavoLayout();
    }

    bindGlobalItemContextMenu();
    sendFavo();//初始化自选
    addEventListener('MWICoreItemPriceUpdated', updateFavo);

    function refreshCurrentItemHints() {
      const currentItem = document.querySelector(".MarketplacePanel_currentItem__3ercC");
      const tradeHistoryDiv = document.querySelector("#mooket_tradeHistory");
      const btnFavo = document.querySelector("#mooket_addFavo");
      if (tradeHistoryDiv) {
        tradeHistoryDiv.title = mwi.isZh ? "我的最近买/卖价格" : "My recent buy/sell price";
      }
      if (btnFavo) {
        btnFavo.title = mwi.isZh ? "左键添加到自选，右键当前物品也可添加" : "Left click to add favorite, or right click the current item";
      }
      if (currentItem) {
        currentItem.title = mwi.isZh ? "右键添加到自选" : "Right click to add favorite";
      }
    }

    // 监听订单簿更新消息
    if (typeof mwi.hookMessage === 'function') {
      mwi.hookMessage('market_item_order_books_updated', (msg) => {
        try {
          const payload = msg?.obj ? msg : { obj: msg, type: 'market_item_order_books_updated' };
          ingestOrderBookPayload(payload);
        } catch (err) {
          console.error('hook 订单簿消息失败', err);
        }
      });
    }

    addEventListener("MWILangChanged", () => {
      updateMoodays();
      updateIndicatorButtons();
      updateFavo();
      refreshCurrentItemHints();
      if (uiContainer.style.display === 'none') {
        btn_close.value = mwi.isZh ? "📈显示图表" : "Show";
      } else {
        btn_close.value = mwi.isZh ? "📈隐藏图表" : "Hide";
      }
      if (curHridName) {
        const nextHrid = curHridName;
        const nextDay = curDay;
        const nextLevel = curLevel;
        curHridName = null;
        requestItemPrice(nextHrid, nextDay, nextLevel);
      }

    });
    btn_close.onclick = toggle;

    window.addEventListener('resize', function () {
      updateFavoLayout();
      if (uiContainer.style.display !== 'none') {
        clampExpandedContainer();
        save_config();
      } else {
        keepToggleButtonVisible();
        save_config();
      }
    });

    let resizeSaveTimer = null;
    function scheduleResizePersistence() {
      if (uiContainer.style.display === 'none') return;
      updateFavoLayout();
      if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
      resizeSaveTimer = setTimeout(() => {
        clampExpandedContainer();
        save_config();
      }, 120);
    }

    if (typeof ResizeObserver !== 'undefined') {
      const panelResizeObserver = new ResizeObserver(() => {
        scheduleResizePersistence();
      });
      panelResizeObserver.observe(container);
    }

    function getOrderBookCacheKey(itemHrid, level = 0) {
      return `${itemHrid}:${Number(level) || 0}`;
    }

    function ingestOrderBookPayload(payload) {
      const eventType =
        payload?.type ??
        payload?.detail?.type ??
        payload?.obj?.type;

      if (eventType && eventType !== 'market_item_order_books_updated') {
        return false;
      }

      const itemHrid =
        payload?.marketItemOrderBooks?.itemHrid ??
        payload?.obj?.marketItemOrderBooks?.itemHrid ??
        payload?.detail?.obj?.marketItemOrderBooks?.itemHrid;

      const orderBooks =
        payload?.marketItemOrderBooks?.orderBooks ??
        payload?.obj?.marketItemOrderBooks?.orderBooks ??
        payload?.detail?.obj?.marketItemOrderBooks?.orderBooks;

      if (!itemHrid || !Array.isArray(orderBooks) || !orderBooks.length) {
        return false;
      }

      const updatedAt = Date.now();
      orderBooks.forEach((book, level) => {
        latestOrderBooksByItem.set(getOrderBookCacheKey(itemHrid, level), {
          itemHrid,
          level,
          orderBook: book || { asks: [], bids: [] },
          updatedAt
        });
      });

      if (itemHrid === curHridName) {
        const currentBook = latestOrderBooksByItem.get(getOrderBookCacheKey(itemHrid, curLevel));
        if (currentBook) {
          updateOrderBook(currentBook);
        }
      }

      return true;
    }

    function handlePotentialOrderBookEvent(e) {
      const payload = e?.detail ?? e;
      ingestOrderBookPayload(payload);
    }

    function toggle() {

      if (uiContainer.style.display === 'none') {//展开
        applyExpandedShell();
        uiContainer.style.display = 'flex';
        chartWrap.style.display = 'block';
        bottomPanel.style.display = 'grid';
        favoContainer.style.display = 'grid';
        ctx.style.display = 'block';
        container.style.resize = "both";
        select.style.display = 'inline-flex';
        indicatorBar.style.display = 'flex';
        headerBar.style.justifyContent = 'flex-start';

        btn_close.value = '📈' + (mwi.isZh ? "隐藏图表" : "Hide");
        leftContainer.style.position = 'relative';
        leftContainer.style.top = '0';
        leftContainer.style.left = '0';
        const { maxWidth, maxHeight } = getExpandedBounds();
        container.style.width = Math.min(config.w || chartWidth, maxWidth) + "px";
        container.style.height = Math.min(config.h || chartHeight, maxHeight) + "px";
        container.style.minHeight = "560px";
        container.style.minWidth = "860px";
        container.style.maxWidth = `${maxWidth}px`;
        container.style.maxHeight = `${maxHeight}px`;
        headerBar.style.marginBottom = '0';

        config.visible = true;
        clampExpandedContainer();

        if (delayItemHridName) {
          requestItemPrice(delayItemHridName, curDay, delayItemLevel);
        }
        updateFavo();
        updateFavoLayout();
        if (chart) chart.resize();
        save_config();
      } else {//隐藏
        applyCollapsedShell();
        uiContainer.style.display = 'none';
        chartWrap.style.display = 'none';
        bottomPanel.style.display = 'none';
        favoContainer.style.display = 'none';
        container.style.resize = "none";
        select.style.display = 'none';
        indicatorBar.style.display = 'none';
        headerBar.style.justifyContent = 'flex-start';
        headerBar.style.marginBottom = '0';

        container.style.width = "fit-content";
        container.style.height = "fit-content";
        container.style.minHeight = "0";
        container.style.maxHeight = "none";
        container.style.minWidth = "0";

        if (!config.keepsize) {
          container.style.width = "fit-content";
          container.style.height = "fit-content";
        }

        btn_close.value = '📈' + (mwi.isZh ? "显示图表" : "Show");
        leftContainer.style.position = 'relative'
        leftContainer.style.top = 0;
        leftContainer.style.left = 0;
        config.visible = false;

        keepToggleButtonVisible();
        updateFavo();
        save_config();
      }
    };
    function toggleShow(show = true) {
      if ((uiContainer.style.display !== 'none') !== show) {
        toggle()
      }
    }

    // ====== 底部模块：订单表 + 市场摘要 ======
    const bottomPanel = document.createElement('section');
    const orderBookPanel = document.createElement('section');
    const orderBookHeader = document.createElement('section');
    const orderBookTable = document.createElement('section');
    orderBookTable.id = 'mooket_orderbook_table';
    const orderBookBody = document.createElement('section');
    const orderBookFade = document.createElement('section');
    const imbalanceBar = document.createElement('section');
    const insightPanel = document.createElement('section');

    let currentOrderBook = {
      asks: [],
      bids: [],
      askTotal: 0,
      bidTotal: 0,
      askPct: 50,
      bidPct: 50,
      updatedAt: 0
    };

    bottomPanel.style.display = 'grid';
    bottomPanel.style.gridTemplateColumns = '1fr 1fr';
    bottomPanel.style.gap = '8px';
    bottomPanel.style.width = '100%';
    bottomPanel.style.boxSizing = 'border-box';
    bottomPanel.style.flex = '0 0 210px';
    bottomPanel.style.minHeight = '230px';
    bottomPanel.style.maxHeight = '230px';
    bottomPanel.style.position = 'relative';
    bottomPanel.style.zIndex = '1';
    bottomPanel.style.marginTop = '0';

    orderBookPanel.style.background = 'rgba(16,22,31,0.92)';
    orderBookPanel.style.border = '1px solid rgba(255,255,255,0.08)';
    orderBookPanel.style.borderRadius = '12px';
    orderBookPanel.style.padding = '10px';
    orderBookPanel.style.display = 'flex';
    orderBookPanel.style.flexDirection = 'column';
    orderBookPanel.style.gap = '8px';
    orderBookPanel.style.minHeight = '0';
    orderBookPanel.style.overflow = 'hidden';
    orderBookPanel.style.boxSizing = 'border-box';

    orderBookHeader.style.display = 'flex';
    orderBookHeader.style.justifyContent = 'space-between';
    orderBookHeader.style.alignItems = 'center';
    orderBookHeader.style.fontSize = '13px';
    orderBookHeader.style.color = '#c8d1dc';
    orderBookHeader.style.fontWeight = '600';
    orderBookHeader.innerHTML = `
      <span>${mwi.isZh ? '订单表' : 'Order Book'}</span>
      <span id="mooket_orderbook_time" style="font-size:12px;color:#8b98a9;">--</span>
    `;

    orderBookTable.id = 'mooket_orderbook_table';
    orderBookTable.style.flex = '1 1 auto';
    orderBookTable.style.minHeight = '0';
    orderBookTable.style.position = 'relative';
    orderBookTable.style.overflow = 'hidden';

    orderBookFade.style.position = 'absolute';
    orderBookFade.style.left = '0';
    orderBookFade.style.right = '0';
    orderBookFade.style.bottom = '0';
    orderBookFade.style.height = '14px';
    orderBookFade.style.pointerEvents = 'none';
    orderBookFade.style.background = 'linear-gradient(to top, rgba(16,22,31,0.98) 0%, rgba(16,22,31,0.82) 38%, rgba(16,22,31,0.24) 78%, rgba(16,22,31,0) 100%)';
    orderBookFade.style.zIndex = '2';

    orderBookBody.style.display = 'grid';
    orderBookBody.style.gridTemplateColumns = '1fr 1fr';
    orderBookBody.style.gap = '10px';
    orderBookBody.style.height = '100%';
    orderBookBody.style.minHeight = '0';
    orderBookBody.style.overflowY = 'auto';
    orderBookBody.style.overflowX = 'hidden';
    orderBookBody.style.scrollbarWidth = 'thin';
    orderBookBody.style.scrollbarColor = 'rgba(255,255,255,0.18) transparent';
    orderBookBody.style.paddingRight = '2px';

    imbalanceBar.style.marginTop = '8px';
    imbalanceBar.style.flex = '0 0 auto';
    imbalanceBar.style.paddingBottom = '2px';

    insightPanel.style.background = 'rgba(16,22,31,0.92)';
    insightPanel.style.border = '1px solid rgba(255,255,255,0.08)';
    insightPanel.style.borderRadius = '12px';
    insightPanel.style.padding = '10px';
    insightPanel.style.boxSizing = 'border-box';
    insightPanel.style.minHeight = '190px';

    orderBookTable.appendChild(orderBookBody);
    orderBookTable.appendChild(orderBookFade);

    orderBookPanel.appendChild(orderBookHeader);
    orderBookPanel.appendChild(orderBookTable);
    orderBookPanel.appendChild(imbalanceBar);

    bottomPanel.appendChild(orderBookPanel);
    bottomPanel.appendChild(insightPanel);

    // 自定义滚动条样式
    const orderBookScrollStyle = document.createElement('style');
    orderBookScrollStyle.textContent = `
      #mooket_orderbook_table::-webkit-scrollbar {
        width: 6px;
      }
      #mooket_orderbook_table::-webkit-scrollbar-track {
        background: transparent;
      }
      #mooket_orderbook_table::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.16);
        border-radius: 999px;
      }
      #mooket_orderbook_table::-webkit-scrollbar-thumb:hover {
        background: rgba(255,255,255,0.24);
      }
    `;
    document.head.appendChild(orderBookScrollStyle);

    // 放到左侧图表区域底部
    leftContainer.appendChild(bottomPanel);

    function renderOrderColumn(title, orders, side) {
      const maxVol = Math.max(...(orders || []).map(x => Number(x.volume || 0)), 1);

      const rows = (orders || []).map(order => {
        const price = Number(order.price || 0);
        const volume = Number(order.volume || 0);
        const widthPct = Math.max(6, volume / maxVol * 100);
        const barColor = side === 'ask'
          ? 'rgba(255,77,79,0.18)'
          : 'rgba(0,192,135,0.18)';
        const priceColor = side === 'ask' ? '#ff6b6b' : '#19d3a2';

        return `
          <section style="position:relative;overflow:hidden;border-radius:6px;background:rgba(255,255,255,0.02);">
            <section style="
              position:absolute;
              top:0;
              ${side === 'ask' ? 'right:0;' : 'left:0;'}
              height:100%;
              width:${widthPct}%;
              background:${barColor};
              pointer-events:none;
            "></section>
            <section style="
              position:relative;
              z-index:1;
              display:flex;
              justify-content:space-between;
              align-items:center;
              padding:4px 8px;
              font-size:12px;
              line-height:1.4;
            ">
              <span style="color:${priceColor};">${showNumber(price)}</span>
              <span style="color:#d7dde6;">${showNumber(volume)}</span>
            </section>
          </section>
        `;
      }).join('');

      return `
        <section style="display:flex;flex-direction:column;gap:6px;">
          <section style="display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:600;color:#c8d1dc;padding-bottom:2px;">
            <span>${title}</span>
            <span>${mwi.isZh ? '数量' : 'Vol'}</span>
          </section>
          ${rows || `<section style="font-size:12px;color:#7f8a99;padding:8px 0;">${mwi.isZh ? '暂无数据' : 'No data'}</section>`}
        </section>
      `;
    }

    function renderImbalanceBar(book) {
      const askPct = Number(book.askPct || 0);
      const bidPct = Number(book.bidPct || 0);

      imbalanceBar.innerHTML = `
        <section style="padding-top:2px;">
          <section style="display:flex;justify-content:space-between;font-size:12px;color:#c8d1dc;margin-bottom:6px;">
            <span>${mwi.isZh ? '卖盘' : 'Ask'} ${askPct.toFixed(1)}%</span>
            <span>${mwi.isZh ? '买盘' : 'Bid'} ${bidPct.toFixed(1)}%</span>
          </section>
          <section style="height:14px;background:rgba(255,255,255,0.06);border-radius:999px;overflow:hidden;display:flex;">
            <section style="width:${askPct}%;background:rgba(255,77,79,0.88);"></section>
            <section style="width:${bidPct}%;background:rgba(0,192,135,0.88);"></section>
          </section>
        </section>
      `;
    }

    function buildMarketSummary({
      lastBid,
      lastAsk,
      lastMid,
      dayVolumeTotal,
      bidPct,
      askPct
    }) {
      let dominantSide = mwi.isZh ? '均衡' : 'Balanced';
      let dominantSideColor = '#9fb3c8';
      if (bidPct >= 60) {
        dominantSide = mwi.isZh ? '买方' : 'Bid';
        dominantSideColor = '#20c997';
      } else if (askPct >= 60) {
        dominantSide = mwi.isZh ? '卖方' : 'Ask';
        dominantSideColor = '#ff6b6b';
      }

      const spreadValue = (lastAsk != null && lastBid != null) ? Math.max(0, lastAsk - lastBid) : null;

      return {
        dominantSide,
        dominantSideColor,
        spreadValue,
        volumeValue: dayVolumeTotal ?? null
      };
    }

    function renderInsightPanel(summary) {
      insightPanel.innerHTML = `
        <section style="font-size:13px;font-weight:600;color:#c8d1dc;margin-bottom:10px;">
          ${mwi.isZh ? '市场摘要' : 'Market Summary'}
        </section>

        <section style="
          display:grid;
          grid-template-columns: 1fr 1fr;
          gap:4px 10px;
          font-size:13px;
          color:#c8d1dc;
          font-weight:600;
          line-height:1.45;
          margin-bottom:4px;
        ">
          <div>${mwi.isZh ? '主力' : 'Dominant'}：<span style="color:${summary.dominantSideColor};">${summary.dominantSide}</span></div>
          <div>${mwi.isZh ? '价差' : 'Spread'}：<span style="color:#c8d1dc;">${showNumber(summary.spreadValue ?? '-')}</span></div>
          <div>${mwi.isZh ? '成交量' : 'Volume'}：<span style="color:#c8d1dc;">${showNumber(summary.volumeValue ?? '-')}</span></div>
        </section>
      `;
    }

    function renderOrderBook(book) {
      orderBookBody.innerHTML = `
        ${renderOrderColumn(mwi.isZh ? '卖单' : 'Asks', book.asks || [], 'ask')}
        ${renderOrderColumn(mwi.isZh ? '买单' : 'Bids', book.bids || [], 'bid')}
      `;
      renderImbalanceBar(book);

      const timeNode = orderBookHeader.querySelector('#mooket_orderbook_time');
      if (timeNode) {
        timeNode.textContent = book.updatedAt
          ? new Date(book.updatedAt).toLocaleTimeString()
          : '--';
      }
    }

    function mergeOrdersByPrice(orders, side = 'ask') {
      const map = new Map();

      for (const item of orders || []) {
        const price = Number(item.price ?? item.p ?? 0);
        const volume = Number(item.volume ?? item.amount ?? item.quantity ?? item.q ?? item.count ?? 0);
        if (!price || !volume) continue;
        map.set(price, (map.get(price) || 0) + volume);
      }

      const merged = [...map.entries()].map(([price, volume]) => ({ price, volume }));

      if (side === 'ask') {
        merged.sort((a, b) => a.price - b.price);
      } else {
        merged.sort((a, b) => b.price - a.price);
      }

      return merged;
    }

    function updateOrderBook(rawData) {
      const source =
        rawData?.orderBook ??
        rawData?.marketItemOrderBook ??
        rawData?.marketItemOrderBooks?.orderBooks?.[rawData?.level ?? 0] ??
        rawData?.orderBooks?.[rawData?.level ?? 0] ??
        rawData;

      const asks = mergeOrdersByPrice(
        source?.asks || source?.sellOrders || source?.sell_orders || [],
        'ask'
      ).slice(0, 20);

      const bids = mergeOrdersByPrice(
        source?.bids || source?.buyOrders || source?.buy_orders || [],
        'bid'
      ).slice(0, 20);

      const askTotal = asks.reduce((sum, x) => sum + Number(x.volume || 0), 0);
      const bidTotal = bids.reduce((sum, x) => sum + Number(x.volume || 0), 0);
      const total = askTotal + bidTotal;

      currentOrderBook = {
        asks,
        bids,
        askTotal,
        bidTotal,
        askPct: total > 0 ? askTotal / total * 100 : 0,
        bidPct: total > 0 ? bidTotal / total * 100 : 0,
        updatedAt: rawData?.updatedAt || Date.now()
      };

      renderOrderBook(currentOrderBook);
    }

    function hideExternalTooltip() {
      externalTooltip.style.display = 'none';
      externalTooltip.innerHTML = '';
      renderMetricBar();
    }

    let metricBarState = null;

    function renderMetricBar(dataIndex = null) {
      if (!metricBarState) {
        metricBar.innerHTML = '';
        return;
      }

      const resolveValue = (series, latestValue) => {
        if (dataIndex == null || !Array.isArray(series)) return latestValue;
        const pointValue = series[dataIndex];
        return pointValue != null && !isNaN(pointValue) ? pointValue : latestValue;
      };

      const metricItems = [];
      if (config.indicators.ma) {
        metricItems.push(`<span style="color:rgba(147, 197, 253, 0.98);">MA5 ${showNumber(resolveValue(metricBarState.ma5Series, metricBarState.lastMa5) ?? '-')}</span>`);
        metricItems.push(`<span style="color:rgba(125, 211, 252, 0.95);">MA10 ${showNumber(resolveValue(metricBarState.ma10Series, metricBarState.lastMa10) ?? '-')}</span>`);
        metricItems.push(`<span style="color:rgba(191, 219, 254, 0.98);">MA20 ${showNumber(resolveValue(metricBarState.ma20Series, metricBarState.lastMa20) ?? '-')}</span>`);
      }
      if (config.indicators.boll) {
        metricItems.push(`<span style="color:rgba(255, 170, 72, 0.95);">${mwi.isZh ? '布林上' : 'Boll U'} ${showNumber(resolveValue(metricBarState.bollUpperSeries, metricBarState.lastBollUpper) ?? '-')}</span>`);
        metricItems.push(`<span style="color:rgba(214, 110, 28, 0.98);">${mwi.isZh ? '布林中' : 'Boll M'} ${showNumber(resolveValue(metricBarState.bollMiddleSeries, metricBarState.lastBollMiddle) ?? '-')}</span>`);
        metricItems.push(`<span style="color:rgba(255, 170, 72, 0.82);">${mwi.isZh ? '布林下' : 'Boll L'} ${showNumber(resolveValue(metricBarState.bollLowerSeries, metricBarState.lastBollLower) ?? '-')}</span>`);
      }
      if (config.indicators.spread) {
        metricItems.push(`<span style="color:rgba(255,255,255,0.78);">${mwi.isZh ? '价差线' : 'Spread'} ${showNumber(resolveValue(metricBarState.spreadSeries, metricBarState.lastSpread) ?? '-')}</span>`);
      }

      metricBar.innerHTML = metricItems.join('');
    }

    function renderExternalTooltip(context) {
      const tooltipModel = context?.tooltip;
      const visiblePoints = tooltipModel?.dataPoints?.filter(point => !point.dataset?.mooketIndicator) || [];
      if (!tooltipModel || tooltipModel.opacity === 0 || !visiblePoints.length) {
        hideExternalTooltip();
        return;
      }

      const hoveredIndex = visiblePoints[0]?.dataIndex;
      renderMetricBar(Number.isInteger(hoveredIndex) ? hoveredIndex : null);

      const title = tooltipModel.title?.[0] || '';
      const rows = [...visiblePoints].sort((a, b) => {
        return (a.dataset?.order ?? 99) - (b.dataset?.order ?? 99);
      }).map(point => {
        const color = point.dataset?.borderColor || point.dataset?.backgroundColor || '#d7dde6';
        const label = point.dataset?.label || '';
        const value = showNumber(point.parsed?.y ?? point.raw ?? '-');
        return `
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="width:10px;height:10px;border-radius:2px;background:${color};box-shadow:0 0 0 2px rgba(255,255,255,0.12) inset;"></span>
            <span style="color:#d7dde6;">${label}: ${value}</span>
          </div>
        `;
      }).join('');

      externalTooltip.innerHTML = `
        <div style="font-size:13px;font-weight:700;color:#ffffff;margin-bottom:${rows ? '8px' : '0'};">${title}</div>
        <div style="display:flex;flex-direction:column;gap:4px;">${rows}</div>
      `;
      externalTooltip.style.display = 'block';

      const canvasRect = context.chart.canvas.getBoundingClientRect();
      const viewportPadding = 12;
      const offsetX = 18;
      const offsetY = 10;
      const tooltipRect = externalTooltip.getBoundingClientRect();

      let left = canvasRect.left + tooltipModel.caretX + offsetX;
      let top = canvasRect.top + tooltipModel.caretY - tooltipRect.height - offsetY;

      if (left + tooltipRect.width > window.innerWidth - viewportPadding) {
        left = canvasRect.left + tooltipModel.caretX - tooltipRect.width - offsetX;
      }
      if (left < viewportPadding) {
        left = viewportPadding;
      }

      if (top < viewportPadding) {
        top = canvasRect.top + tooltipModel.caretY + offsetY;
      }
      if (top + tooltipRect.height > window.innerHeight - viewportPadding) {
        top = Math.max(viewportPadding, window.innerHeight - tooltipRect.height - viewportPadding);
      }

      externalTooltip.style.left = `${Math.round(left)}px`;
      externalTooltip.style.top = `${Math.round(top)}px`;
    }

    let chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: []
      },
      options: {
        onClick: save_config,
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        layout: {
          padding: {
            top: 6,
            right: 8,
            bottom: 28,
            left: 8
          }
        },
        scales: {
        x: {
          type: 'time',
          offset: true,
          time: {
            displayFormats: {
              hour: 'HH:mm',
              day: 'MM/dd',
              month: 'yy/MM'
            }
          },
          grid: {
            color: "rgba(255,255,255,0.08)"
          },
          ticks: {
            color: "#9aa4b2",
            autoSkip: true,
            autoSkipPadding: 18,
            maxTicksLimit: 6,
            maxRotation: 0,
            minRotation: 0,
            padding: 8,
            callback: function(value) {
              return formatAxisTime(value, curDay);
            }
          }
        },
        y: {
          position: 'right',
          beginAtZero: false,
          grid: {
            color: "rgba(255,255,255,0.08)"
          },
          ticks: {
            color: "#9aa4b2",
            callback: showNumber
          }
        },
        volumeY: {
          position: 'right',
          beginAtZero: true,
          grid: {
            display: false
          },
          ticks: {
            color: "#6f7a88",
            callback: showNumber,
            maxTicksLimit: 3
          }
        },
        spreadY: {
          position: 'left',
          display: false,
          beginAtZero: true,
          grid: {
            display: false
          },
          ticks: {
            display: false
          }
        }
      },
        plugins: {
          tooltip: {
            enabled: false,
            external: renderExternalTooltip,
            mode: 'index',
            intersect: false,
            backgroundColor: '#1b2028',
            borderColor: '#343b48',
            borderWidth: 1,
            titleColor: '#ffffff',
            bodyColor: '#d7dde6',
            callbacks: {
              title: function(context) {
                const xValue = context?.[0]?.parsed?.x;
                return formatTooltipTime(xValue);
              },
              label: function(context) {
                const label = context.dataset.label || '';
                const value = context.parsed.y;
                return `${label}: ${showNumber(value)}`;
              }
            }
          },
          crosshair: {
            line: { color: 'rgba(255,255,255,0.35)', width: 1 },
            zoom: { enabled: false }
          },
          title: {
            display: true,
            text: "",
            color: "#f5f7fa",
            font: {
              size: 16,
              weight: '600',
            },
            padding: {
              top: 4,
              bottom: 6
            }
          },
          legend: {
            display: false
          }
        },
        elements: {
          point: {
            radius: 0,
            hoverRadius: 3
          },
          line: {
            borderWidth: 2,
            tension: 0.12
          },
          bar: {
            borderRadius: 0
          }
        }
      }
    });

    const officialHistoryInflight = new Map();
    const sqliteHistoryInflight = new Map();
    const q7HistoryInflight = new Map();

    async function fetchOfficialHistory(itemHridName, level = 0, day = 1, signal) {
      const manifest = await fetchOfficialHistoryManifest(signal);
      const entry = resolveOfficialHistoryManifestEntry(manifest, itemHridName, level);
      if (!entry?.path) return [];

      const cacheKey = `${itemHridName}:${Number(level) || 0}:${entry.path}`;
      if (officialHistoryInflight.has(cacheKey)) {
        return officialHistoryInflight.get(cacheKey);
      }

      const requestPromise = (async () => {
        const response = await fetch(toAbsoluteUrl(entry.path, OFFICIAL_HISTORY_MANIFEST_URL), { signal });
        if (!response.ok) {
          throw new Error(`Official history shard HTTP ${response.status}`);
        }

        const payload = await response.json();
        const rows = normalizeSqliteHistoryRows(payload?.rows || payload);
        if (!rows.length) return [];

        await marketHistoryStore.saveHistorySeries(
          itemHridName,
          level,
          rows,
          "official_archive",
          { days: Number(entry.maxDays || day) || day }
        );
        logHistoryDebug("official_history imported", {
          itemHrid: itemHridName,
          level: Number(level) || 0,
          day: Number(day) || 1,
          rows: rows.length,
          shard: entry.path
        });
        return rows;
      })();

      officialHistoryInflight.set(cacheKey, requestPromise);
      return requestPromise.finally(() => {
        officialHistoryInflight.delete(cacheKey);
      });
    }

    async function fetchSqliteHistory(itemHridName, level = 0, day = 1, signal) {
      if (Number(level) !== 0) return [];

      const manifest = await fetchSqliteHistoryManifest(signal);
      const entry = resolveSqliteHistoryManifestEntry(manifest, itemHridName);
      if (!entry?.path) return [];

      const cacheKey = `${itemHridName}:${entry.path}`;
      if (sqliteHistoryInflight.has(cacheKey)) {
        return sqliteHistoryInflight.get(cacheKey);
      }

      const requestPromise = (async () => {
        const response = await fetch(toAbsoluteUrl(entry.path, SQLITE_HISTORY_MANIFEST_URL), { signal });
        if (!response.ok) {
          throw new Error(`SQLite history shard HTTP ${response.status}`);
        }

        const payload = await response.json();
        const rows = normalizeSqliteHistoryRows(payload?.rows || payload);
        if (!rows.length) return [];

        await marketHistoryStore.saveHistorySeries(
          itemHridName,
          level,
          rows,
          "sqlite_history",
          { days: Number(entry.maxDays || day) || day }
        );
        logHistoryDebug("sqlite_history imported", {
          itemHrid: itemHridName,
          level: Number(level) || 0,
          day: Number(day) || 1,
          rows: rows.length,
          shard: entry.path
        });
        return rows;
      })();

      sqliteHistoryInflight.set(cacheKey, requestPromise);
      return requestPromise.finally(() => {
        sqliteHistoryInflight.delete(cacheKey);
      });
    }

    function normalizeQ7HistoryRows(payload, itemHridName, level = 0) {
      const variantKey = String(Number(level) || 0);
      const rows = payload?.[itemHridName]?.[variantKey];
      if (!Array.isArray(rows)) return [];
      return rows
        .filter(row => Number(row?.time) > 0)
        .map(row => ({
          time: Number(row.time),
          a: row.a ?? row.ask ?? -1,
          b: row.b ?? row.bid ?? -1,
          p: row.p ?? row.price ?? null,
          v: row.v ?? row.volume ?? null
        }))
        .sort((left, right) => left.time - right.time);
    }

    async function fetchQ7VolumeHistory(itemHridName, level = 0, day = 1, signal) {
      const cacheKey = `${itemHridName}:${Number(level) || 0}:${Number(day) || 1}`;
      if (q7HistoryInflight.has(cacheKey)) {
        return q7HistoryInflight.get(cacheKey);
      }

      const requestPromise = (async () => {
        const url = new URL(Q7_HISTORY_URL);
        url.searchParams.append("item_id", itemHridName);
        url.searchParams.set("variant", String(Number(level) || 0));
        url.searchParams.set("days", String(Math.max(1, Number(day) || 1)));
        const response = await fetch(url, { signal, cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Q7 history HTTP ${response.status}`);
        }
        const payload = await response.json();
        const rows = normalizeQ7HistoryRows(payload, itemHridName, level);
        if (!rows.length) return [];

        await marketHistoryStore.mergeHistorySeries(
          itemHridName,
          level,
          rows,
          "third_party_history",
          { days: Number(day) || 1 }
        );
        logHistoryDebug("q7_volume_history merged", {
          itemHrid: itemHridName,
          level: Number(level) || 0,
          day: Number(day) || 1,
          rows: rows.length
        });
        return rows;
      })();

      q7HistoryInflight.set(cacheKey, requestPromise);
      return requestPromise.finally(() => {
        q7HistoryInflight.delete(cacheKey);
      });
    }

    function hasUsableHistoricalVolume(stats, day) {
      const requestedDays = Number(day) || 1;
      const labels = Array.isArray(stats?.sourceLabels) ? stats.sourceLabels : [];
      const historicalVolumeSources = new Set([
        "official_archive",
        "legacy_history",
        "third_party_history"
      ]);

      if (labels.some(label => historicalVolumeSources.has(label))) {
        return true;
      }

      if (requestedDays <= 1) {
        return Number(stats?.cachedVolumeDays || 0) >= 1;
      }

      return Number(stats?.cachedVolumeDays || 0) >= Math.min(requestedDays, 3);
    }

    function requestItemPrice(itemHridName, day = 1, level = 0) {
      if (!itemHridName) return;
      if (curHridName === itemHridName && curLevel == level && curDay == day) return;//防止重复请求

      delayItemHridName = curHridName = itemHridName;
      delayItemLevel = curLevel = level;
      curDay = day;

      curShowItemName = (mwi.isZh ? mwi.lang.zh.translation.itemNames[itemHridName] : mwi.lang.en.translation.itemNames[itemHridName]) ?? itemHridName;
      curShowItemName += curLevel > 0 ? `(+${curLevel})` : "";

      day = Number(day);
      if (!day || !days.includes(day)) {
        day = days[0];
        config.dayIndex = 0;
      }
      let time = day * 3600 * 24;

      const params = new URLSearchParams();
      params.append("name", curHridName);
      params.append("level", curLevel);
      params.append("time", time);
      historyRequestToken += 1;
      const requestToken = historyRequestToken;
      historyAbortController?.abort();
      historyAbortController = new AbortController();

      marketHistoryStore.queryHistory(curHridName, curLevel, day)
        .then(async rows => {
          if (
            requestToken !== historyRequestToken ||
            curHridName !== itemHridName ||
            Number(curLevel) !== Number(level) ||
            Number(curDay) !== Number(day)
          ) {
            return true;
          }

          const stats = await marketHistoryStore.getHistoryStats(curHridName, curLevel, day);
          const hasPriceCoverage = marketHistoryStore.hasCoverage(rows, day);
          const hasVolumeCoverage = hasUsableHistoricalVolume(stats, day);

          if (hasPriceCoverage && hasVolumeCoverage) {
            setSourceNotice("history", null);
            updateChart(marketHistoryStore.toChartData(rows, stats, day), curDay);
            return true;
          }

          try {
            const importedRows = await fetchOfficialHistory(curHridName, curLevel, day, historyAbortController.signal);
            if (
              requestToken !== historyRequestToken ||
              curHridName !== itemHridName ||
              Number(curLevel) !== Number(level) ||
              Number(curDay) !== Number(day)
            ) {
              return true;
            }

            if (importedRows.length > 0) {
              setSourceNotice("history", null);
              const mergedRows = await marketHistoryStore.queryHistory(curHridName, curLevel, day);
              const mergedStats = await marketHistoryStore.getHistoryStats(curHridName, curLevel, day);
              updateChart(marketHistoryStore.toChartData(mergedRows, mergedStats, day), curDay);
              if (marketHistoryStore.hasCoverage(mergedRows, day) && hasUsableHistoricalVolume(mergedStats, day)) return true;
            }
          } catch (err) {
            if (err?.name === 'AbortError') return true;
            setSourceNotice("history", {
              message: mwi.isZh
                ? "无法访问github接口，请检查当前网络环境"
                : "GitHub interface is not reachable; please check current network access"
            });
            console.warn("官方历史分片读取失败，尝试其他本地来源", err);
          }

          if (Number(curLevel) === 0 && Number(day) >= SQLITE_HISTORY_IMPORT_MIN_DAYS) {
            try {
              const importedRows = await fetchSqliteHistory(curHridName, curLevel, day, historyAbortController.signal);
              if (
                requestToken !== historyRequestToken ||
                curHridName !== itemHridName ||
                Number(curLevel) !== Number(level) ||
                Number(curDay) !== Number(day)
              ) {
                return true;
              }

              if (importedRows.length > 0) {
                setSourceNotice("history", {
                  message: mwi.isZh
                    ? "无法访问github接口，请检查当前网络环境；当前已降级到SQLite历史分片"
                    : "GitHub interface is not reachable; please check current network access. Currently using SQLite history shards"
                });
                const mergedRows = await marketHistoryStore.queryHistory(curHridName, curLevel, day);
                const mergedStats = await marketHistoryStore.getHistoryStats(curHridName, curLevel, day);
                updateChart(marketHistoryStore.toChartData(mergedRows, mergedStats, day), curDay);
                if (marketHistoryStore.hasCoverage(mergedRows, day) && hasUsableHistoricalVolume(mergedStats, day)) return true;
              }
            } catch (err) {
              if (err?.name === 'AbortError') return true;
              console.warn("SQLite 历史分片读取失败，保留本地快照", err);
            }
          }

          const beforeQ7Rows = await marketHistoryStore.queryHistory(curHridName, curLevel, day);
          const beforeQ7Stats = await marketHistoryStore.getHistoryStats(curHridName, curLevel, day);
          if (marketHistoryStore.hasCoverage(beforeQ7Rows, day) && !hasUsableHistoricalVolume(beforeQ7Stats, day)) {
            try {
              const importedRows = await fetchQ7VolumeHistory(curHridName, curLevel, day, historyAbortController.signal);
              if (
                requestToken !== historyRequestToken ||
                curHridName !== itemHridName ||
                Number(curLevel) !== Number(level) ||
                Number(curDay) !== Number(day)
              ) {
                return true;
              }
              if (importedRows.length > 0) {
                const mergedRows = await marketHistoryStore.queryHistory(curHridName, curLevel, day);
                const mergedStats = await marketHistoryStore.getHistoryStats(curHridName, curLevel, day);
                updateChart(marketHistoryStore.toChartData(mergedRows, mergedStats, day), curDay);
                if (marketHistoryStore.hasCoverage(mergedRows, day) && hasUsableHistoricalVolume(mergedStats, day)) return true;
              }
            } catch (err) {
              if (err?.name === 'AbortError') return true;
              console.warn("Q7 单物品成交量补洞失败，继续其他来源", err);
            }
          }

          try {
            const response = await fetch(`${LEGACY_HISTORY_URL}?${params}`, { signal: historyAbortController.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (
              requestToken !== historyRequestToken ||
              curHridName !== itemHridName ||
              Number(curLevel) !== Number(level) ||
              Number(curDay) !== Number(day)
            ) {
              return true;
            }
            const fallbackRows = [];
            const bidRows = data?.bid || data?.bids || [];
            const askRows = data?.ask || data?.asks || [];
            const fallbackLength = Math.min(bidRows.length, askRows.length);
            for (let i = 0; i < fallbackLength; i++) {
              const bidRow = bidRows[i] || {};
              const askRow = askRows[i] || {};
              fallbackRows.push({
                time: askRow.time ?? bidRow.time,
                a: askRow.price ?? askRow.ask ?? -1,
                b: bidRow.price ?? bidRow.bid ?? -1,
                p: askRow.avg ?? bidRow.avg ?? 0,
                v: askRow.volume ?? bidRow.volume ?? askRow.v ?? bidRow.v ?? 0
              });
            }
            if (fallbackRows.length > 0) {
              await marketHistoryStore.saveHistorySeries(curHridName, curLevel, fallbackRows, "legacy_history", { days: day });
              setSourceNotice("history", {
                message: mwi.isZh
                  ? "无法访问github接口，请检查当前网络环境；当前已降级到旧历史接口"
                  : "GitHub interface is not reachable; please check current network access. Currently using legacy history API"
              });
              const mergedRows = await marketHistoryStore.queryHistory(curHridName, curLevel, day);
              const mergedStats = await marketHistoryStore.getHistoryStats(curHridName, curLevel, day);
              updateChart(marketHistoryStore.toChartData(mergedRows, mergedStats, day), curDay);
              return true;
            }
          } catch (err) {
            if (err?.name === 'AbortError') return true;
            console.warn("旧历史接口读取失败，保留本地历史", err);
          }

          setSourceNotice("history", {
            fallback: rows.length
              ? (mwi.isZh ? "本地历史缓存" : "local history cache")
              : null
          });
          updateChart(marketHistoryStore.toChartData(rows, stats, day), curDay);
          return true;
        })
        .catch(err => {
          console.error("读取本地历史失败", err);
        });

      requestOrderBook(curHridName, curLevel);
    }

    const latestOrderBooksByItem = new Map();
    let orderBookRetryTimer = null;
    let orderBookRetryToken = 0;
    let historyRequestToken = 0;
    let historyAbortController = null;

    function requestOrderBook(itemHridName, level = 0) {
      orderBookRetryToken += 1;
      const currentToken = orderBookRetryToken;
      const cacheKey = getOrderBookCacheKey(itemHridName, level);

      if (orderBookRetryTimer) {
        clearTimeout(orderBookRetryTimer);
        orderBookRetryTimer = null;
      }

      const maxAttempts = 8;
      const retryDelay = 180;

      const tryReadOrderBook = (attempt = 1) => {
        if (currentToken !== orderBookRetryToken) return;

        try {
          const cached = latestOrderBooksByItem.get(cacheKey);

          if (
            cached &&
            cached.itemHrid === itemHridName &&
            cached.level === Number(level || 0)
          ) {
            if (orderBookRetryTimer) {
              clearTimeout(orderBookRetryTimer);
              orderBookRetryTimer = null;
            }
            updateOrderBook(cached);
            return;
          }

          if (attempt < maxAttempts) {
            orderBookRetryTimer = setTimeout(() => {
              tryReadOrderBook(attempt + 1);
            }, retryDelay);
            return;
          }

          console.warn('订单簿多次重试后仍未就绪，显示空盘口', itemHridName, level);
          updateOrderBook({
            itemHrid: itemHridName,
            level: Number(level || 0),
            orderBook: { asks: [], bids: [] },
            updatedAt: 0
          });
        } catch (err) {
          if (attempt < maxAttempts) {
            orderBookRetryTimer = setTimeout(() => {
              tryReadOrderBook(attempt + 1);
            }, retryDelay);
            return;
          }

          console.error('读取订单簿失败', err);
          updateOrderBook({
            itemHrid: itemHridName,
            level: Number(level || 0),
            orderBook: { asks: [], bids: [] },
            updatedAt: 0
          });
        }
      };

      tryReadOrderBook(1);
    }

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    function normalizeDateInput(value) {
      if (value instanceof Date) return value;
      if (typeof value === "number") {
        return new Date(value > 1e12 ? value : value * 1000);
      }
      return new Date(value);
    }

    function formatAxisTime(value, range) {
      const date = normalizeDateInput(value);
      if (Number.isNaN(date.getTime())) return '';
      const hours = pad2(date.getHours());
      const minutes = pad2(date.getMinutes());
      const day = date.getDate();
      const month = date.getMonth() + 1;
      const shortYear = String(date.getFullYear()).slice(-2);

      if (Number(range) <= 3) return `${hours}:${minutes}`;
      if (Number(range) <= 60) return `${month}/${day}`;
      return `${shortYear}/${month}`;
    }

    function formatTooltipTime(value) {
      const date = normalizeDateInput(value);
      if (Number.isNaN(date.getTime())) return '';
      const hours = pad2(date.getHours());
      const minutes = pad2(date.getMinutes());
      if (mwi.isZh) return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()} ${hours}:${minutes}`;
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${hours}:${minutes}`;
    }

    function formatCompactNumber(value, suffix) {
      const sign = value < 0 ? -1 : 1;
      const compactAbs = Math.trunc(Math.abs(value) * 10) / 10;
      const compact = compactAbs * sign;
      return Number.isInteger(compact) ? `${compact}${suffix}` : `${compact.toFixed(1).replace(/\.0$/, '')}${suffix}`;
    }

    function showNumber(num) {
      if (num === null || num === undefined || num === '') return '-';
      if (isNaN(num)) return num;

      const n = Number(num);
      const abs = Math.abs(n);

      if (abs === 0) return '0';

      if (abs >= 1e10) {
        return formatCompactNumber(n / 1e9, 'B');
      }

      if (abs >= 1e7) {
        return formatCompactNumber(n / 1e6, 'M');
      }

      if (abs >= 1e4) {
        return formatCompactNumber(n / 1e3, 'K');
      }

      if (abs < 1) return n.toFixed(2);
      return `${Math.floor(n)}`;
    }

    function getPriceStep(maxPrice) {
      if (maxPrice >= 1000000) return 10000;
      if (maxPrice >= 100000) return 1000;
      if (maxPrice >= 10000) return 100;
      if (maxPrice >= 1000) return 10;
      if (maxPrice >= 100) return 5;
      if (maxPrice >= 10) return 1;
      return 0.1;
    }

    function calcAxisBounds(prices) {
      const valid = prices.filter(v => v !== null && v !== undefined && !isNaN(v) && Number(v) > 0);
      if (!valid.length) return { min: 0, max: 1 };

      const minPrice = Math.min(...valid);
      const maxPrice = Math.max(...valid);
      const step = getPriceStep(maxPrice);
      const range = Math.max(maxPrice - minPrice, maxPrice * 0.08, 1);
      const padding = Math.max(step * 2, range * 0.08);

      return {
        min: Math.max(0, minPrice - padding),
        max: maxPrice + padding
      };
    }

    function renderChartStatus() {
      return;
    }

    let lastChartPayload = null;

    function cloneChartRows(rows) {
      return Array.isArray(rows) ? rows.map(row => ({ ...row })) : [];
    }

    function cloneChartDataPayload(data) {
      return {
        ...data,
        bid: cloneChartRows(data?.bid || data?.bids),
        ask: cloneChartRows(data?.ask || data?.asks),
        stats: data?.stats ? { ...data.stats } : {}
      };
    }

    function hasFullWindow(series, endIndex, period) {
      if (endIndex - period + 1 < 0) return false;
      for (let i = endIndex - period + 1; i <= endIndex; i++) {
        if (!Number.isFinite(series[i])) return false;
      }
      return true;
    }

    function buildMovingAverage(series, period) {
      return series.map((_, index) => {
        if (!hasFullWindow(series, index, period)) return null;
        let sum = 0;
        for (let i = index - period + 1; i <= index; i++) {
          sum += Number(series[i]);
        }
        return sum / period;
      });
    }

    function buildBollingerBands(askSeries, bidSeries, period = 20, multiplier = 2) {
      const upper = [];
      const middle = [];
      const lower = [];

      for (let index = 0; index < askSeries.length; index++) {
        if (!hasFullWindow(askSeries, index, period) || !hasFullWindow(bidSeries, index, period)) {
          upper.push(null);
          middle.push(null);
          lower.push(null);
          continue;
        }

        let askSum = 0;
        let bidSum = 0;
        for (let i = index - period + 1; i <= index; i++) {
          askSum += Number(askSeries[i]);
          bidSum += Number(bidSeries[i]);
        }
        const askMean = askSum / period;
        const bidMean = bidSum / period;

        let askVariance = 0;
        let bidVariance = 0;
        for (let i = index - period + 1; i <= index; i++) {
          askVariance += (Number(askSeries[i]) - askMean) ** 2;
          bidVariance += (Number(bidSeries[i]) - bidMean) ** 2;
        }

        const askStdDev = Math.sqrt(askVariance / period);
        const bidStdDev = Math.sqrt(bidVariance / period);
        upper.push(askMean + askStdDev * multiplier);
        middle.push((askMean + bidMean) / 2);
        lower.push(Math.max(0, bidMean - bidStdDev * multiplier));
      }

      return { upper, middle, lower };
    }

    function getAxisMaxTicks(range) {
      if (Number(range) <= 3) return 6;
      if (Number(range) <= 20) return 5;
      if (Number(range) <= 60) return 4;
      if (Number(range) <= 180) return 5;
      return 6;
    }
    
    //data={'bid':[{time:1,price:1}],'ask':[{time:1,price:1}]}
    function updateChart(data, day) {
      lastChartPayload = { data: cloneChartDataPayload(data), day: Number(day) || 1 };
      data.bid = data.bid || data.bids || [];
      data.ask = data.ask || data.asks || [];

      for (let i = data.bid.length - 1; i >= 0; i--) {
        const bidItem = data.bid[i];
        const askItem = data.ask[i];

        if (!bidItem || !askItem) {
          data.bid.splice(i, 1);
          data.ask.splice(i, 1);
          continue;
        }

        const bidPrice = Number(bidItem.price);
        const askPrice = Number(askItem.price);

        if (
          (!Number.isFinite(bidPrice) || bidPrice <= 0) &&
          (!Number.isFinite(askPrice) || askPrice <= 0)
        ) {
          data.bid.splice(i, 1);
          data.ask.splice(i, 1);
        } else {
          bidItem.price = Number.isFinite(bidPrice) && bidPrice > 0 ? bidPrice : null;
          askItem.price = Number.isFinite(askPrice) && askPrice > 0 ? askPrice : null;
        }
      }

      const len = Math.min(data.bid.length, data.ask.length);
      if (!len) {
        metricBarState = null;
        chart.data.labels = [];
        chart.data.datasets = [];
        metricBar.innerHTML = '';
        renderChartStatus(data?.stats || {});
        hideExternalTooltip();

        renderInsightPanel(buildMarketSummary({
          lastBid: null,
          lastAsk: null,
          lastMid: null,
          dayVolumeTotal: 0,
          bidPct: currentOrderBook.bidPct,
          askPct: currentOrderBook.askPct,
          bidTotal: currentOrderBook.bidTotal,
          askTotal: currentOrderBook.askTotal
        }));

        chart.update();
        return;
      }

      const labels = [];
      const bidSeries = [];
      const askSeries = [];
      const volumeSeries = [];
      const midSeries = [];
      const spreadSeries = [];

      for (let i = 0; i < len; i++) {
        const bidItem = data.bid[i];
        const askItem = data.ask[i];
        const ts = (askItem.time ?? bidItem.time) * 1000;

        const bid = bidItem.price ?? null;
        const ask = askItem.price ?? null;

        labels.push(new Date(ts));
        bidSeries.push(bid);
        askSeries.push(ask);

        const volume =
          askItem.volume ??
          bidItem.volume ??
          askItem.v ??
          bidItem.v ??
          null;
        volumeSeries.push(volume);

        if (bid != null && ask != null) {
          midSeries.push((bid + ask) / 2);
          spreadSeries.push(ask - bid);
        } else if (ask != null) {
          midSeries.push(ask);
          spreadSeries.push(null);
        } else if (bid != null) {
          midSeries.push(bid);
          spreadSeries.push(null);
        } else {
          midSeries.push(null);
          spreadSeries.push(null);
        }
      }

      const lastValid = arr => {
        for (let i = arr.length - 1; i >= 0; i--) {
          if (arr[i] != null && !isNaN(arr[i])) return arr[i];
        }
        return null;
      };

      const lastBid = lastValid(bidSeries);
      const lastAsk = lastValid(askSeries);
      const lastVol = lastValid(volumeSeries);
      const lastMid = lastValid(midSeries);
      const lastSpread = (lastAsk != null && lastBid != null) ? (lastAsk - lastBid) : null;
      const lastSpreadPct = (lastSpread != null && lastMid) ? (lastSpread / lastMid * 100) : null;
      const latestLabelDate = labels.length > 0 ? labels[labels.length - 1] : null;
      const latestDayKey = latestLabelDate
        ? `${latestLabelDate.getFullYear()}-${latestLabelDate.getMonth()}-${latestLabelDate.getDate()}`
        : null;
      const dayVolumeTotal = volumeSeries.reduce((sum, volume, index) => {
        const pointDate = labels[index];
        if (!pointDate || latestDayKey === null) return sum;
        const pointDayKey = `${pointDate.getFullYear()}-${pointDate.getMonth()}-${pointDate.getDate()}`;
        return pointDayKey === latestDayKey ? sum + (Number(volume) || 0) : sum;
      }, 0);
      const latestDayHasVolume = volumeSeries.some((volume, index) => {
        const pointDate = labels[index];
        if (!pointDate || latestDayKey === null) return false;
        const pointDayKey = `${pointDate.getFullYear()}-${pointDate.getMonth()}-${pointDate.getDate()}`;
        return pointDayKey === latestDayKey && volume != null;
      });
      const dayVolumeDisplay = latestDayHasVolume ? dayVolumeTotal : (mwi.isZh ? '未获取' : 'N/A');
      const historyStats = data?.stats || {};
      const chartSignature = [
        curHridName,
        Number(curLevel) || 0,
        Number(day) || 0,
        historyStats.totalPoints || 0,
        historyStats.dominantSource || "none",
        (historyStats.sourceLabels || []).join("|")
      ].join("::");
      if (historyDebugState.lastChartSignature !== chartSignature) {
        historyDebugState.lastChartSignature = chartSignature;
        logHistoryDebug("chart dataset ready", {
          itemHrid: curHridName,
          level: Number(curLevel) || 0,
          day: Number(day) || 1,
          totalPoints: historyStats.totalPoints || 0,
          cachedDays: historyStats.cachedDays || 0,
          dominantSource: historyStats.dominantSource || null,
          sources: historyStats.sourceLabels || []
        });
      }

      const ma5Series = buildMovingAverage(midSeries, 5);
      const ma10Series = buildMovingAverage(midSeries, 10);
      const ma20Series = buildMovingAverage(midSeries, 20);
      const bollBands = buildBollingerBands(askSeries, bidSeries, 20, 2);
      metricBarState = {
        ma5Series,
        ma10Series,
        ma20Series,
        bollUpperSeries: bollBands.upper,
        bollMiddleSeries: bollBands.middle,
        bollLowerSeries: bollBands.lower,
        spreadSeries,
        lastMa5: lastValid(ma5Series),
        lastMa10: lastValid(ma10Series),
        lastMa20: lastValid(ma20Series),
        lastBollUpper: lastValid(bollBands.upper),
        lastBollMiddle: lastValid(bollBands.middle),
        lastBollLower: lastValid(bollBands.lower),
        lastSpread
      };
      renderMetricBar();

      renderChartStatus(historyStats);

      const summary = buildMarketSummary({
        lastBid,
        lastAsk,
        lastMid,
        dayVolumeTotal: dayVolumeDisplay,
        bidPct: currentOrderBook.bidPct,
        askPct: currentOrderBook.askPct,
        bidTotal: currentOrderBook.bidTotal,
        askTotal: currentOrderBook.askTotal
      });

      renderInsightPanel(summary);

      const allPriceSeries = [
        ...bidSeries,
        ...askSeries,
      ];

      if (config.indicators.ma) {
        allPriceSeries.push(...ma5Series, ...ma10Series, ...ma20Series);
      }
      if (config.indicators.boll) {
        allPriceSeries.push(...bollBands.upper, ...bollBands.middle, ...bollBands.lower);
      }

      const validPriceSeries = allPriceSeries.filter(v => v !== null && v !== undefined && !isNaN(v));

      const { min: yMin, max: yMax } = calcAxisBounds(validPriceSeries);

      chart.data.labels = labels;
      chart.options.plugins.title.text = curShowItemName;
      chart.options.scales.x.ticks.maxTicksLimit = getAxisMaxTicks(day);

      const datasets = [
        {
          type: 'line',
          label: mwi.isZh ? '卖一' : 'Ask 1',
          data: askSeries,
          yAxisID: 'y',
          borderColor: '#ff4d4f',
          backgroundColor: '#ff4d4f',
          borderWidth: 2,
          pointRadius: 0,
          spanGaps: false,
          order: 10
        },
        {
          type: 'line',
          label: mwi.isZh ? '买一' : 'Bid 1',
          data: bidSeries,
          yAxisID: 'y',
          borderColor: '#00c087',
          backgroundColor: '#00c087',
          borderWidth: 2,
          pointRadius: 0,
          spanGaps: false,
          order: 10
        },
        {
          type: 'bar',
          label: mwi.isZh ? '成交量' : 'Volume',
          data: volumeSeries,
          yAxisID: 'volumeY',
          backgroundColor: 'rgba(255,255,255,0.22)',
          borderColor: 'rgba(255,255,255,0.28)',
          borderWidth: 1,
          barPercentage: 0.9,
          categoryPercentage: 0.9,
          order: 30
        }
      ];

      if (config.indicators.ma) {
        datasets.push({
          type: 'line',
          label: mwi.isZh ? 'MA5(mid)' : 'MA5(mid)',
          data: ma5Series,
          yAxisID: 'y',
          borderColor: 'rgba(147, 197, 253, 0.98)',
          backgroundColor: 'rgba(147, 197, 253, 0.98)',
          borderWidth: 1.2,
          pointRadius: 0,
          spanGaps: false,
          order: 6,
          mooketIndicator: true
        });
        datasets.push({
          type: 'line',
          label: mwi.isZh ? 'MA10(mid)' : 'MA10(mid)',
          data: ma10Series,
          yAxisID: 'y',
          borderColor: 'rgba(125, 211, 252, 0.95)',
          backgroundColor: 'rgba(125, 211, 252, 0.95)',
          borderWidth: 1.1,
          pointRadius: 0,
          spanGaps: false,
          order: 6,
          mooketIndicator: true
        });
        datasets.push({
          type: 'line',
          label: mwi.isZh ? 'MA20(mid)' : 'MA20(mid)',
          data: ma20Series,
          yAxisID: 'y',
          borderColor: 'rgba(191, 219, 254, 0.98)',
          backgroundColor: 'rgba(191, 219, 254, 0.98)',
          borderWidth: 1,
          pointRadius: 0,
          spanGaps: false,
          order: 6,
          mooketIndicator: true
        });
      }

      if (config.indicators.boll) {
        datasets.push({
          type: 'line',
          label: mwi.isZh ? '布林上轨' : 'Boll Upper',
          data: bollBands.upper,
          yAxisID: 'y',
          borderColor: 'rgba(255, 170, 72, 0.95)',
          backgroundColor: 'rgba(255, 170, 72, 0.16)',
          borderWidth: 1,
          pointRadius: 0,
          spanGaps: false,
          order: 5,
          fill: false,
          mooketIndicator: true
        });
        datasets.push({
          type: 'line',
          label: mwi.isZh ? '布林下轨' : 'Boll Lower',
          data: bollBands.lower,
          yAxisID: 'y',
          borderColor: 'rgba(255, 170, 72, 0.9)',
          backgroundColor: 'rgba(255, 170, 72, 0.12)',
          borderWidth: 1,
          pointRadius: 0,
          spanGaps: false,
          order: 5,
          fill: '-1',
          mooketIndicator: true
        });
        datasets.push({
          type: 'line',
          label: mwi.isZh ? '布林中轨' : 'Boll Mid',
          data: bollBands.middle,
          yAxisID: 'y',
          borderColor: 'rgba(214, 110, 28, 0.98)',
          backgroundColor: 'rgba(214, 110, 28, 0.98)',
          borderWidth: 1.1,
          pointRadius: 0,
          spanGaps: false,
          order: 5,
          fill: false,
          mooketIndicator: true
        });
      }

      if (config.indicators.spread) {
        datasets.push({
          type: 'line',
          label: mwi.isZh ? '价差线' : 'Spread',
          data: spreadSeries,
          yAxisID: 'spreadY',
          borderColor: 'rgba(255, 255, 255, 0.52)',
          backgroundColor: 'rgba(255, 255, 255, 0.52)',
          borderWidth: 1,
          pointRadius: 0,
          spanGaps: false,
          borderDash: [3, 3],
          order: 7,
          mooketIndicator: true
        });
      }

      chart.data.datasets = datasets;

      chart.options.scales.y.min = yMin;
      chart.options.scales.y.max = yMax;
      const validSpreadSeries = spreadSeries.filter(v => Number.isFinite(v) && v >= 0);
      chart.options.scales.spreadY.max = validSpreadSeries.length ? Math.max(...validSpreadSeries) * 1.2 + 1 : 1;
      chart.update();
    }

    function save_config() {
      if (mwi.character?.gameMode !== "standard") {
        return;//铁牛不保存
      }

      if (chart && chart.data && chart.data.datasets) {
        config.filter.ask = chart.getDatasetMeta(0).visible;
        config.filter.bid = chart.getDatasetMeta(1).visible;
        config.filter.volume = chart.getDatasetMeta(2).visible;
      }
      if (container.checkVisibility()) {
        const rect = container.getBoundingClientRect();
        config.x = Math.round(rect.x);
        config.y = Math.round(rect.y);

        if (uiContainer.style.display === 'none') {
          config.minWidth = container.offsetWidth;
          config.minHeight = container.offsetHeight;
        }
        else {
          config.w = container.offsetWidth;
          config.h = container.offsetHeight;
        }
      }

      localStorage.setItem("mooket_config", JSON.stringify(config));
    }
    let lastItemHridLevel = null;
    setInterval(() => {
      let inMarketplace = document.querySelector(".MarketplacePanel_marketplacePanel__21b7o")?.checkVisibility();
      let hasFavo = Object.entries(config.favo || {}).length > 0;

      container.style.display = "block";
        try {
          let currentItem = document.querySelector(".MarketplacePanel_currentItem__3ercC");
          let levelStr = currentItem?.querySelector(".Item_enhancementLevel__19g-e");
          let enhancementLevel = parseInt(levelStr?.textContent.replace("+", "") || "0");
          let iconUse = currentItem?.querySelector(".Icon_icon__2LtL_ use");
          let iconHref = iconUse?.href?.baseVal || iconUse?.getAttribute("href") || iconUse?.getAttribute("xlink:href");
          let iconId = iconHref?.split("#")[1];
          let itemHrid = iconId ? "/items/" + iconId : null;
          let itemHridLevel = itemHrid ? itemHrid + ":" + enhancementLevel : null;
          if (itemHrid && currentItem) {
            if (lastItemHridLevel !== itemHridLevel) {//防止重复请求
              //显示历史价格

              let tradeHistoryDiv = document.querySelector("#mooket_tradeHistory");
              if (!tradeHistoryDiv) {
                tradeHistoryDiv = document.createElement("div");
                tradeHistoryDiv.id = "mooket_tradeHistory";
                tradeHistoryDiv.style.position = "absolute";
                tradeHistoryDiv.style.marginTop = "-24px";
                tradeHistoryDiv.style.whiteSpace = "nowrap";
                tradeHistoryDiv.style.left = "50%";
                tradeHistoryDiv.style.transform = "translateX(-50%)";
                tradeHistoryDiv.title = mwi.isZh ? "我的最近买/卖价格" : "My recently buy/sell price";
                currentItem.prepend(tradeHistoryDiv);
              }
              if (trade_history[itemHridLevel]) {
                let buy = trade_history[itemHridLevel].buy || "--";
                let sell = trade_history[itemHridLevel].sell || "--";

                tradeHistoryDiv.innerHTML = `
        <span style="color:red">${showNumber(buy)}</span>
        <span style="color:#AAAAAA">/</span>
        <span style="color:lime">${showNumber(sell)}</span>`;
                tradeHistoryDiv.style.display = "block";
              } else {
                tradeHistoryDiv.style.display = "none";
              }
              //添加订阅button
              if (mwi.character?.gameMode === "standard") {
                let btn_favo = document.querySelector("#mooket_addFavo");
                if (!btn_favo) {
                  btn_favo = document.createElement('button');
                  btn_favo.type = 'button';
                  btn_favo.id = "mooket_addFavo";
                  btn_favo.innerText = '📌';
                  btn_favo.style.position = "absolute";
                  btn_favo.style.padding = "0";
                  btn_favo.style.fontSize = "18px";
                  btn_favo.style.marginLeft = "32px";
                  btn_favo.title = mwi.isZh ? "左键添加到自选，右键当前物品也可添加" : "Left click to add favorite, or right click the current item";
                  btn_favo.onclick = () => { if (btn_favo.itemHridLevel) addFavo(btn_favo.itemHridLevel) };
                  currentItem.prepend(btn_favo);
                }
                btn_favo.itemHridLevel = itemHridLevel;
                currentItem.dataset.mooketItemHridLevel = itemHridLevel;
                currentItem.title = mwi.isZh ? "右键添加到自选" : "Right click to add favorite";
                if (!currentItem.dataset.mooketContextMenuBound) {
                  currentItem.dataset.mooketContextMenuBound = "1";
                  currentItem.addEventListener("contextmenu", (event) => {
                    event.preventDefault();
                    let targetItemHridLevel = currentItem.dataset.mooketItemHridLevel;
                    if (targetItemHridLevel) addFavo(targetItemHridLevel);
                  });
                }
              }
              //记录当前
              lastItemHridLevel = itemHridLevel;
              if (uiContainer.style.display === 'none') {//延迟到打开的时候请求
                delayItemHridName = itemHrid;
                delayItemLevel = enhancementLevel;
              } else {
                requestItemPrice(itemHrid, curDay, enhancementLevel);
              }
            }
          }
        } catch (e) {
          console.error(e)
        }
    }, 500);
    //setInterval(updateInventoryStatus, 60000);
    toggleShow(config.visible);
    keepToggleButtonVisible();
    updateOrderBook({
      itemHrid: null,
      level: 0,
      orderBook: { asks: [], bids: [] },
      updatedAt: 0
    });
    renderChartStatus({});
    renderInsightPanel(buildMarketSummary({
      lastBid: null,
      lastAsk: null,
      lastMid: null,
      dayVolumeTotal: 0,
      bidPct: currentOrderBook.bidPct,
      askPct: currentOrderBook.askPct
    }));

    console.info("mooket 初始化完成");
    runStartupHealthChecks().catch(error => {
      console.warn("mooket startup health checks failed", error);
    });
  }
  new Promise(resolve => {
    let count = 0;
    const interval = setInterval(() => {
      if (document.body && mwi.character?.gameMode) {//等待必须组件加载完毕后再初始化
        clearInterval(interval);
        resolve(true);
        return;
      }
      count++;
      if (count > 30) {
        const hasGamePanel = !!document.querySelector(".GamePage_gamePanel__3uNKN");
        clearInterval(interval);
        if (hasGamePanel) {
          console.info("mooket 初始化超时，部分功能受限");
          resolve(true);
        } else {
          console.info("mooket 初始化失败");
          resolve(false);
        }
      }
      //最多等待10秒
    }, 1000);
  }).then((ready) => {
    if (ready) {
      mooket();
    }
  });

})();
