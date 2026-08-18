/**
 * 行为模拟模块 - 模拟人类操作，避免被检测
 * BehaviorSimulator - Simulates human interactions to avoid detection
 */

class BehaviorSimulator {
  constructor() {
    this.minDelay = 50;
    this.maxDelay = 150;
  }

  /**
   * 随机延迟
   */
  delay(min, max) {
    const ms = min + Math.random() * (max - min);
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * 模拟人类点击（完整事件序列 + 鼠标轨迹）
   */
  async click(element) {
    if (!element) {
      throw new Error('元素不存在');
    }

    // 1. 滚动到元素可见区域
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await this.delay(200, 500);

    // 2. 模拟鼠标移动轨迹
    await this.simulateMouseMove(element);

    // 3. 按真实事件序列触发
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2 + (Math.random() - 0.5) * 10;
    const y = rect.top + rect.height / 2 + (Math.random() - 0.5) * 10;

    const eventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0
    };

    // 按顺序触发事件
    const events = ['mouseover', 'mouseenter', 'mousedown', 'focus', 'mouseup', 'click'];
    for (const eventType of events) {
      element.dispatchEvent(new MouseEvent(eventType, eventOptions));
      await this.delay(10, 30);
    }

    // 触发 pointer 事件（现代浏览器）
    element.dispatchEvent(new PointerEvent('pointerdown', { ...eventOptions, pointerType: 'mouse', isPrimary: true }));
    await this.delay(10, 20);
    element.dispatchEvent(new PointerEvent('pointerup', { ...eventOptions, pointerType: 'mouse', isPrimary: true }));

    return true;
  }

  /**
   * 清空并输入文本（逐字符 + 随机间隔）
   */
  async clearAndType(element, text) {
    if (!element) {
      throw new Error('元素不存在');
    }

    // 聚焦
    element.focus();
    await this.delay(50, 100);

    // 点击激活
    element.click();
    await this.delay(50, 100);

    // 清空
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));

    // 逐字符输入
    for (const char of text) {
      // 模拟输入
      element.value += char;
      
      // 触发 input 事件
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: char
      }));

      // 随机延迟（模拟人类打字速度）
      await this.delay(30, 120);
    }

    // 触发 change 事件
    element.dispatchEvent(new Event('change', { bubbles: true }));

    return true;
  }

  /**
   * 模拟鼠标移动轨迹（贝塞尔曲线 + 随机扰动）
   */
  async simulateMouseMove(targetElement) {
    const rect = targetElement.getBoundingClientRect();
    
    // 起点（随机位置）
    const startX = Math.random() * window.innerWidth;
    const startY = Math.random() * window.innerHeight;
    
    // 终点（元素中心 + 随机偏移）
    const endX = rect.left + rect.width / 2 + (Math.random() - 0.5) * 20;
    const endY = rect.top + rect.height / 2 + (Math.random() - 0.5) * 20;

    // 随机步数（5-10步）
    const steps = 5 + Math.floor(Math.random() * 6);

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      
      // 贝塞尔曲线插值 + 随机扰动
      const x = startX + (endX - startX) * t + (Math.random() - 0.5) * 30;
      const y = startY + (endY - startY) * t + (Math.random() - 0.5) * 30;

      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientX: x,
        clientY: y
      }));

      await this.delay(10, 25);
    }
  }

  /**
   * 等待元素出现
   */
  waitForSelector(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) {
        return resolve(el);
      }

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for: ${selector}`));
      }, timeout);
    });
  }

  /**
   * 等待元素消失
   */
  async waitForSelectorGone(selector, timeout = 10000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const el = document.querySelector(selector);
      if (!el) {
        return true;
      }
      await this.delay(100, 200);
    }
    
    return false;
  }

  /**
   * 滚动页面
   */
  async scrollDown(distance = 500) {
    const startY = window.scrollY;
    const endY = startY + distance + (Math.random() - 0.5) * 100;
    
    const steps = 10 + Math.floor(Math.random() * 10);
    
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = startY + (endY - startY) * t;
      
      window.scrollTo(0, y);
      await this.delay(20, 50);
    }
  }

  /**
   * 随机移动鼠标（模拟用户活动）
   */
  async randomMouseMove() {
    const x = Math.random() * window.innerWidth;
    const y = Math.random() * window.innerHeight;
    
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: x,
      clientY: y
    }));
  }

  /**
   * 检测是否有验证码
   */
  detectCaptcha() {
    // 检测极验验证码
    const geetest = document.querySelector('.geetest_panel, .geetest_slider');
    if (geetest) return { type: 'geetest', element: geetest };

    // 检测普通滑块
    const slider = document.querySelector('.slider, .slide-verify, [class*="captcha"]');
    if (slider) return { type: 'slider', element: slider };

    return null;
  }
}

// 导出
if (typeof window !== 'undefined') {
  window.BehaviorSimulator = BehaviorSimulator;
}