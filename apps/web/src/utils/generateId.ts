/**
 * 生成一个全局唯一的字符串 ID。
 *
 * 不使用 crypto.randomUUID()：该 API 仅在安全上下文
 * （HTTPS 或 localhost）中可用，而本应用常通过局域网 IP
 * （http://192.168.x.x）访问，属于非安全上下文，调用会抛异常。
 * 这里用随机数 + 时间戳组合，保证并发下基本唯一。
 */
export function generateId(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand()}-${rand()}`;
}
