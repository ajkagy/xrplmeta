export default class InternalSQLError extends Error{
	constructor({ message, sql }){
		super(message)

		this.stack = `\n\n${sql}\n\n${this.stack}`
	}
}