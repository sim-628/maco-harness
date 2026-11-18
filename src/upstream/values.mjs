// Derived from DeepSeek Harness ca33fd6. Copyright (c) 2026 DeepSeek (MIT).
export function assertNever(value, context) {
    const rendered = JSON.stringify(value) ?? String(value);
    throw new Error(`unreachable variant${context ? ` in ${context}` : ''}: ${rendered}`);
}
function hasIntrinsicConstructor(prototype, name) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    const constructor = descriptor?.value;
    if (typeof constructor !== 'function') return false;
    try {
        return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(name === 'Array' ? Array : Object);
    } catch  {
        return false;
    }
}
function isIntrinsicObjectPrototype(value) {
    return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object');
}
function hasPlainArrayPrototype(value) {
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false;
    const objectPrototype = Object.getPrototypeOf(prototype);
    return typeof objectPrototype === 'object' && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype);
}
function hasPlainObjectPrototype(value) {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype);
}
function enumerableStringKeys(value) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key)=>typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) return undefined;
    return keys;
}
function walkJsonValue(value, detach) {
    const ancestors = new Set();
    let root;
    let parent;
    const assign = (item)=>{
        if (parent === undefined) {
            if (detach) root = item;
        } else if (parent.kind === 'array') {
            if (parent.target !== undefined) parent.target[parent.key] = item;
        } else if (parent.target !== undefined) {
            Object.defineProperty(parent.target, parent.key, {
                value: item,
                enumerable: true,
                configurable: true,
                writable: true
            });
        }
    };
    const frames = [];
    let current = value;
    for(;;){
        if (current === null) {
            assign(null);
        } else if (typeof current === 'boolean' || typeof current === 'string') {
            assign(current);
        } else if (typeof current === 'number') {
            if (!Number.isFinite(current) || Object.is(current, -0)) return undefined;
            assign(current);
        } else {
            if (typeof current !== 'object') return undefined;
            if (ancestors.has(current)) return undefined;
            if (Array.isArray(current)) {
                if (!hasPlainArrayPrototype(current)) return undefined;
                const length = current.length;
                if (Reflect.ownKeys(current).length !== length + 1) return undefined;
                const target = detach ? [] : undefined;
                if (target !== undefined) assign(target);
                let indices;
                if (!Number.isInteger(length)) {
                    indices = [];
                    for(let index = length - 1; index >= 0; index--)indices.push(index);
                }
                frames.push({
                    kind: 'array',
                    source: current,
                    length: indices?.length ?? length,
                    index: 0,
                    key: 0,
                    indices,
                    target
                });
            } else {
                if (!hasPlainObjectPrototype(current)) return undefined;
                const keys = enumerableStringKeys(current);
                if (keys === undefined) return undefined;
                const target = detach ? {} : undefined;
                if (target !== undefined) assign(target);
                frames.push({
                    kind: 'object',
                    source: current,
                    keys,
                    index: 0,
                    key: '',
                    target
                });
            }
            ancestors.add(current);
        }
        for(;;){
            const frame = frames.at(-1);
            if (frame === undefined) return detach ? root : true;
            const length = frame.kind === 'array' ? frame.length : frame.keys.length;
            if (frame.index >= length) {
                ancestors.delete(frame.source);
                frames.pop();
                continue;
            }
            const index = frame.index++;
            parent = frame;
            if (frame.kind === 'array') {
                const key = frame.indices === undefined ? index : frame.indices[frame.indices.length - index - 1];
                if (key === undefined) return undefined;
                if (!Object.prototype.hasOwnProperty.call(frame.source, key)) return undefined;
                frame.key = key;
                current = frame.source[key];
            } else {
                const key = frame.keys[index];
                if (key === undefined) return undefined;
                frame.key = key;
                current = frame.source[key];
            }
            break;
        }
    }
}
export function snapshotJsonValue(value) {
    return walkJsonValue(value, true);
}
export function isJsonValue(value) {
    return walkJsonValue(value, false) === true;
}
