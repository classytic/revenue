/**
 * Dependency Injection Container
 * @classytic/revenue
 *
 * Lightweight DI container for managing dependencies
 * Inspired by: Awilix, InversifyJS but much simpler
 */

export class Container {
  constructor() {
    this._services = new Map();
    this._singletons = new Map();
  }

  /**
   * Register a service
   * @param {string} name - Service name
   * @param {any} implementation - Service implementation or factory
   * @param {Object} options - Registration options
   */
  register(name, implementation, options = {}) {
    this._services.set(name, {
      implementation,
      singleton: options.singleton !== false, // Default to singleton
      factory: options.factory || false,
    });
    return this;
  }

  /**
   * Register a singleton service
   * @param {string} name - Service name
   * @param {any} implementation - Service implementation
   */
  singleton(name, implementation) {
    return this.register(name, implementation, { singleton: true });
  }

  /**
   * Register a transient service (new instance each time)
   * @param {string} name - Service name
   * @param {Function} factory - Factory function
   */
  transient(name, factory) {
    return this.register(name, factory, { singleton: false, factory: true });
  }

  /**
   * Get a service from the container
   * @param {string} name - Service name
   * @returns {any} Service instance
   */
  get(name) {
    // Check if already instantiated as singleton
    if (this._singletons.has(name)) {
      return this._singletons.get(name);
    }

    const service = this._services.get(name);
    if (!service) {
      throw new Error(`Service "${name}" not registered in container`);
    }

    // Handle factory functions
    if (service.factory) {
      const instance = service.implementation(this);
      if (service.singleton) {
        this._singletons.set(name, instance);
      }
      return instance;
    }

    // Handle direct values
    if (service.singleton) {
      this._singletons.set(name, service.implementation);
    }
    return service.implementation;
  }

  /**
   * Check if service is registered
   * @param {string} name - Service name
   * @returns {boolean}
   */
  has(name) {
    return this._services.has(name);
  }

  /**
   * Get all registered service names
   * @returns {string[]}
   */
  keys() {
    return Array.from(this._services.keys());
  }

  /**
   * Clear all services (useful for testing)
   */
  clear() {
    this._services.clear();
    this._singletons.clear();
  }

  /**
   * Create a child container (for scoped dependencies)
   * @returns {Container}
   */
  createScope() {
    const scope = new Container();
    // Copy parent services
    this._services.forEach((value, key) => {
      scope._services.set(key, value);
    });
    return scope;
  }
}

export default Container;
